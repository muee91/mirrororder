from __future__ import annotations

from threading import Thread
from typing import Any
from urllib.parse import parse_qs

from .semantic_encoder import SemanticEmbeddingConfig
from .semantic_index import ProjectSemanticIndexer
from .semantic_search import SemanticSearcher, safe_search_payload


_INSTALLED = False
_REFRESH_TASKS = {
    "prepare_project",
    "incremental_analyze",
    "transcribe",
    "evidence_extract",
    "auto_resolve",
}


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _workspace_for_service(service: Any) -> Any:
    workspace = getattr(service, "workspace", None)
    if workspace is not None:
        return workspace
    current = getattr(service, "current", None)
    if current is None:
        raise RuntimeError("请求尚未选择工作区")
    return current.workspace


def _searcher(service: Any, project_id: str) -> SemanticSearcher:
    project = service.project(project_id)
    workspace = _workspace_for_service(service)
    return SemanticSearcher(workspace.workspace_id, project_id, project.config)


def _deterministic_answer(query: str, retrieval: dict[str, Any]) -> str:
    results = [row for row in _as_list(retrieval.get("results")) if isinstance(row, dict)]
    if not results:
        return "当前语义索引里没有找到足够相关的画面、对白或场记证据。可以换一个更具体的动作、对白、场记关键词或素材特征再搜。"
    lines = [f"找到 {len(results)} 条相关制作证据："]
    for index, row in enumerate(results[:6], start=1):
        source = str(row.get("source_label", "素材") or "素材")
        group_id = str(row.get("group_id", "") or "")
        snippet = str(row.get("snippet", "") or "").strip()
        where = f" · Take {group_id}" if group_id else " · 独立场记素材"
        lines.append(f"{index}. [{source}]{where}：{snippet[:260]}")
    lines.append("这些是检索证据，不是 Best/Keep/Reject 或最终归集结论。")
    return "\n".join(lines)


def install_semantic_runtime() -> None:
    """Install read-only semantic retrieval above existing production evidence.

    The runtime adds no review/editorial/automation authority. It indexes only
    already-produced VLM descriptions, cached ASR and human slate facts, then
    grounds assistant answers and read-only API search in that evidence.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import model_registry, tasks as tasks_module, web_server
    from .agent_tools import AgentToolRegistry
    from .assistant_orchestrator import AssistantOrchestrator

    original_make_handler = web_server.make_handler
    original_capabilities = web_server.WorkspaceService.capabilities
    original_update = tasks_module.TaskManager._update
    original_models_public = model_registry.ModelRegistry.public

    def models_public_with_semantic(registry: Any) -> dict[str, Any]:
        payload = original_models_public(registry)
        payload["semantic_embedding"] = SemanticEmbeddingConfig.from_env().public()
        return payload

    def search_project_semantics(
        tools: AgentToolRegistry,
        query: str,
        *,
        limit: int = 12,
        sources: list[str] | None = None,
    ) -> dict[str, Any]:
        searcher = SemanticSearcher(
            tools.workspace_id,
            tools.project_id,
            tools.config,
        )
        return safe_search_payload(
            searcher.search(query, limit=limit, sources=sources, refresh=False)
        )

    def answer_with_semantic(self: AssistantOrchestrator, message: str) -> dict[str, Any]:
        text = str(message or "").strip()[:3000]
        if not text:
            raise ValueError("消息不能为空")
        current = self.status()
        current = self.store.append_message("user", text, source="user")
        project = self.tools.inspect_project()
        attention = self.tools.list_attention_groups(limit=30)
        supervisor = self._supervisor_notes(limit=36)
        try:
            retrieval = SemanticSearcher(
                self.workspace_id,
                self.project_id,
                self.config,
            ).search(text, limit=14, refresh=True)
            safe_retrieval = safe_search_payload(retrieval)
        except Exception:
            safe_retrieval = {
                "contract": "semantic_search.v1",
                "query": text,
                "mode": "unavailable",
                "results": [],
                "summary": {},
                "semantics": {"read_only": True},
            }

        if self.language.enabled:
            system = (
                "你是镜序助理，服务短剧后期制作。回答用户前优先使用 semantic_retrieval 中召回的画面、对白和人工场记证据；"
                "没有召回证据时明确说证据不足，不要用常识补写素材内容。"
                "画面描述来自可重建视觉索引；ASR可能有转写误差；场记是人工生产证据，但都不能自行升级成Best/Reject、最终归集或Editorial Decision。"
                "场记里的‘只要前半段’可以解释为局部可用，但没有人工精确范围时绝不能编造秒数。"
                "多机位画面里可见人物不等于正在说话的人。不要声称执行了未发生的动作，也不要输出模型、向量或运行时技术宣传。"
                "输出严格JSON：{\"answer\":\"中文回答\"}。"
            )
            raw = self.language.complete_json(
                system=system,
                context={
                    "question": text,
                    "semantic_retrieval": safe_retrieval,
                    "project": project,
                    "attention": attention[:12],
                    "script_supervisor": supervisor[:20],
                    "assistant_summary": current.get("summary", ""),
                },
                temperature=0.15,
            )
            answer = str(_as_dict(raw).get("answer", "") or "").strip()
        else:
            answer = _deterministic_answer(text, safe_retrieval)
        if not answer:
            answer = _deterministic_answer(text, safe_retrieval)
        saved = self.store.append_message("assistant", answer, source=self.models.assistant.source)
        return {
            "answer": answer,
            "assistant": saved,
            "retrieval": safe_retrieval,
        }

    def capabilities_with_semantic(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        embedding = SemanticEmbeddingConfig.from_env()
        payload["semantic_search"] = {
            "contract": "semantic_search.v1",
            "read": True,
            "sources": ["visual", "speech", "slate"],
            "keyword_fallback": True,
            "vector_enabled": embedding.enabled,
            "device_local_index": True,
            "editorial_authority": False,
        }
        return payload

    def update_with_semantic(
        manager: Any,
        config: Any,
        task_id: str,
        status: str | None = None,
        stage: str | None = None,
        progress: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        error: str = "",
        message: str = "",
    ) -> None:
        original_update(
            manager,
            config,
            task_id,
            status=status,
            stage=stage,
            progress=progress,
            result=result,
            error=error,
            message=message,
        )
        if status != "completed":
            return
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return
        task_type = str(task.get("type", "") or "")
        if task_type not in _REFRESH_TASKS:
            return
        project_id = str(task.get("project_id", "") or "")
        workspace_id = str(getattr(manager, "workspace_id", "") or "")
        if not project_id or not workspace_id:
            return
        raw_groups = _as_dict(task.get("targets")).get("group_ids", [])
        group_ids = [str(value) for value in raw_groups if str(value)] if isinstance(raw_groups, list) else []

        def refresh() -> None:
            try:
                ProjectSemanticIndexer(workspace_id, project_id, config).refresh(
                    group_ids=group_ids or None,
                )
            except Exception:
                return

        Thread(target=refresh, daemon=True, name=f"mirror-semantic-{project_id}").start()

    def make_handler_with_semantic(service: Any, web_root):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            @staticmethod
            def _search_parameters(parsed: Any) -> tuple[str, int, list[str] | None]:
                query = parse_qs(str(parsed.query or ""), keep_blank_values=False)
                text = str((query.get("q") or [""])[0] or "").strip()
                try:
                    limit = max(1, min(60, int((query.get("limit") or ["16"])[0] or 16)))
                except ValueError:
                    limit = 16
                raw_sources = str((query.get("sources") or [""])[0] or "")
                sources = [value for value in raw_sources.split(",") if value] or None
                return text, limit, sources

            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "semantic-search"
                ):
                    self._local_only()
                    project_id = parts[3]
                    text, limit, sources = self._search_parameters(parsed)
                    if not text:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "语义搜索内容不能为空")
                    payload = _searcher(service, project_id).search(
                        text,
                        limit=limit,
                        sources=sources,
                        refresh=True,
                    )
                    self._send_json(payload)
                    return
                return super()._app_get(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:4] == ["api", "agent", "v1", "projects"]
                    and parts[5] == "semantic-search"
                ):
                    project_id = parts[4]
                    agent = self._agent("read", project_id)
                    text, limit, sources = self._search_parameters(parsed)
                    if not text:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "语义搜索内容不能为空")
                    payload = safe_search_payload(
                        _searcher(service, project_id).search(
                            text,
                            limit=limit,
                            sources=sources,
                            refresh=False,
                        )
                    )
                    service.tokens.audit(agent, "read:semantic-search", project_id)
                    self._send_json(payload)
                    return
                return super()._agent_get(parsed)

        return Handler

    model_registry.ModelRegistry.public = models_public_with_semantic
    AgentToolRegistry.search_project_semantics = search_project_semantics
    AssistantOrchestrator.answer = answer_with_semantic
    web_server.WorkspaceService.capabilities = capabilities_with_semantic
    web_server.make_handler = make_handler_with_semantic
    tasks_module.TaskManager._update = update_with_semantic
    _INSTALLED = True
