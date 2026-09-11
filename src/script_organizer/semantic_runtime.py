from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs

from .semantic_encoder import SemanticEmbeddingConfig
from .semantic_index import ProjectSemanticIndexer, SEMANTIC_SOURCES
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
    from .resource_scheduler import ResourceCancelled

    original_make_handler = web_server.make_handler
    original_capabilities = web_server.WorkspaceService.capabilities
    original_update = tasks_module.TaskManager._update
    original_task_run = tasks_module.TaskManager._run
    original_models_public = model_registry.ModelRegistry.public

    # Semantic refresh is device-local and rebuildable, but it is still real
    # background work. Register it as a durable task so Status Center is the
    # single place users can observe, cancel and retry that work.
    tasks_module.TASK_TYPES.add("semantic_index")

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
            ).search(text, limit=14, refresh=False)
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
                "你是小镜，服务短剧后期制作。回答用户前优先使用 semantic_retrieval 中召回的画面、对白和人工场记证据；"
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
        from .local_embedding import local_embedding_available

        payload["semantic_search"] = {
            "contract": "semantic_search.v1",
            "read": True,
            "sources": ["visual", "speech", "slate"],
            "keyword_fallback": True,
            "vector_enabled": embedding.enabled or local_embedding_available(),
            "device_local_index": True,
            "editorial_authority": False,
        }
        return payload

    def run_with_semantic(manager: Any, project_id: str, task_id: str) -> None:
        config = manager.project_loader(project_id)
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return original_task_run(manager, project_id, task_id)
        if str(task.get("type", "") or "") != "semantic_index":
            return original_task_run(manager, project_id, task_id)

        workspace_id = str(getattr(manager, "workspace_id", "") or "")
        if not workspace_id:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error="语义索引缺少 workspace_id",
                message="语义索引失败",
            )
            return

        targets = _as_dict(task.get("targets"))
        raw_groups = targets.get("group_ids", [])
        group_ids = [str(value) for value in raw_groups if str(value)] if isinstance(raw_groups, list) else []
        raw_sources = targets.get("sources", [])
        requested_sources = [str(value) for value in raw_sources if str(value)] if isinstance(raw_sources, list) else []
        sources = sorted(set(requested_sources) or SEMANTIC_SOURCES)
        unknown = set(sources) - SEMANTIC_SOURCES
        if unknown:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error="unknown semantic sources: " + ", ".join(sorted(unknown)),
                message="语义索引失败",
            )
            return

        try:
            manager._update(config, task_id, status="running", stage="starting", message="语义索引开始")
            if manager._cancel_requested(config, task_id):
                manager._update(config, task_id, status="cancelled", stage="cancelled", message="语义索引已取消")
                return

            reports: dict[str, Any] = {}
            latest: dict[str, Any] = {}
            total = len(sources)
            with manager._resource(config, task, "embedding", "semantic_index", "语义索引"):
                for index, source in enumerate(sources, start=1):
                    if manager._cancel_requested(config, task_id):
                        manager._update(config, task_id, status="cancelled", stage="cancelled", message="语义索引已取消")
                        return
                    manager._update(
                        config,
                        task_id,
                        stage="semantic_index",
                        progress={"done": index - 1, "total": total},
                        message=f"正在更新{source}证据索引 {index}/{total}",
                    )
                    latest = ProjectSemanticIndexer(workspace_id, project_id, config).refresh(
                        group_ids=group_ids or None,
                        sources=[source],
                    )
                    reports.update(_as_dict(latest.get("sources")))
                    manager._update(
                        config,
                        task_id,
                        progress={"done": index, "total": total},
                        message=f"语义索引 {index}/{total}",
                    )
            result = {
                **latest,
                "contract": "semantic_refresh_task.v1",
                "sources": reports,
            }
            manager._update(
                config,
                task_id,
                status="completed",
                stage="completed",
                progress={"done": total, "total": total},
                result=result,
                message="语义索引已更新",
            )
        except ResourceCancelled:
            manager._update(config, task_id, status="cancelled", stage="cancelled", message="语义索引已取消")
        except Exception as error:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error=str(error),
                message="语义索引失败",
            )

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
        targets = _as_dict(task.get("targets"))
        raw_groups = task.get("affected_group_ids") or targets.get("group_ids", [])
        group_ids = [str(value) for value in raw_groups if str(value)] if isinstance(raw_groups, list) else []
        try:
            manager.submit(
                project_id,
                "semantic_index",
                targets={"group_ids": group_ids},
                idempotency_key=f"semantic-refresh:{task_id}",
                actor="system",
            )
        except Exception:
            # Derived semantic refresh must never fail the source production task.
            # Read paths remain side-effect free; the next background refresh can retry.
            return

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

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "semantic-search"
                ):
                    # 显式计算面：用户在搜索面板按下"搜索"是主动动作，这里
                    # 允许对查询做一次有界的 embedding 编码（本地模型毫秒
                    # 级；远程模型由配置决定）。GET 读路径仍然永不推理。
                    self._local_only()
                    project_id = parts[3]
                    body = web_server._body(self)
                    text = str(body.get("q", "") or "").strip()
                    if not text:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "语义搜索内容不能为空")
                    try:
                        limit = max(1, min(60, int(body.get("limit", 16) or 16)))
                    except (TypeError, ValueError):
                        limit = 16
                    raw_sources = body.get("sources")
                    sources = [str(value) for value in raw_sources if str(value)] if isinstance(raw_sources, list) else None
                    payload = _searcher(service, project_id).search(
                        text,
                        limit=limit,
                        sources=sources,
                        refresh=False,
                    )
                    self._send_json(payload)
                    return
                return super()._app_post(parsed)

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
                        refresh=False,
                        allow_query_embedding=False,
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
                            allow_query_embedding=False,
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
    tasks_module.TaskManager._run = run_with_semantic
    tasks_module.TaskManager._update = update_with_semantic
    _INSTALLED = True
