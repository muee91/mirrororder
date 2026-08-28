from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs

from .semantic_encoder import SemanticEmbeddingConfig
from .semantic_index import ProjectSemanticIndexer, SEMANTIC_SOURCES
from .semantic_profiles import semantic_profiles_public
from .semantic_search import SemanticSearcher, safe_search_payload
from .semantic_task_indexer import refresh_semantic_index_background


_INSTALLED = False
_REFRESH_TASKS = {
    "prepare_project",
    "incremental_analyze",
    "transcribe",
    "evidence_extract",
    "auto_resolve",
}
SEMANTIC_TASK_TYPE = "semantic_index"


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


def _semantic_task_targets(task: dict[str, Any]) -> tuple[list[str] | None, list[str]]:
    targets = _as_dict(task.get("targets"))
    raw_groups = targets.get("group_ids", [])
    if not isinstance(raw_groups, list):
        raise ValueError("semantic_index group_ids 必须是数组")
    group_ids = [str(value) for value in raw_groups if str(value)] or None
    raw_sources = targets.get("sources", [])
    if raw_sources and not isinstance(raw_sources, list):
        raise ValueError("semantic_index sources 必须是数组")
    selected = [str(value) for value in raw_sources if str(value)] if isinstance(raw_sources, list) else []
    sources = sorted(set(selected) if selected else SEMANTIC_SOURCES)
    unknown = set(sources) - SEMANTIC_SOURCES
    if unknown:
        raise ValueError("unknown semantic sources: " + ", ".join(sorted(unknown)))
    return group_ids, sources


def _semantic_task_key(project_id: str, *, reason: str, groups: list[str] | None = None, suffix: str = "") -> str:
    group_part = ",".join(sorted(groups or [])) or "all"
    return f"semantic:{project_id}:{reason}:{group_part}:{suffix}"[:500]


def install_semantic_runtime() -> None:
    """Install read-only semantic retrieval above existing production evidence.

    Search requests never rebuild or embed the project inline. Expensive work is
    represented by a durable ``semantic_index`` task so enabling a local model
    cannot turn Cmd/Ctrl+K into an implicit whole-project indexing request.
    Embedding work is bounded and cancellation-aware between batches; completed
    vectors remain rebuildable device-local evidence only.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import model_registry, tasks as tasks_module, web_server
    from .agent_tools import AgentToolRegistry
    from .assistant_orchestrator import AssistantOrchestrator

    tasks_module.TASK_TYPES.add(SEMANTIC_TASK_TYPE)
    try:
        tasks_module.COMPAT_TASK_TYPES.add(SEMANTIC_TASK_TYPE)
    except AttributeError:
        pass

    original_make_handler = web_server.make_handler
    original_capabilities = web_server.WorkspaceService.capabilities
    original_update = tasks_module.TaskManager._update
    original_run = tasks_module.TaskManager._run
    original_models_public = model_registry.ModelRegistry.public

    def models_public_with_semantic(registry: Any) -> dict[str, Any]:
        payload = original_models_public(registry)
        payload["semantic_embedding"] = SemanticEmbeddingConfig.from_env().public()
        payload["semantic_embedding_profiles"] = semantic_profiles_public()
        return payload

    def search_project_semantics(
        tools: AgentToolRegistry,
        query: str,
        *,
        limit: int = 12,
        sources: list[str] | None = None,
    ) -> dict[str, Any]:
        searcher = SemanticSearcher(tools.workspace_id, tools.project_id, tools.config)
        return safe_search_payload(searcher.search(query, limit=limit, sources=sources, refresh=False))

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
            retrieval = SemanticSearcher(self.workspace_id, self.project_id, self.config).search(
                text,
                limit=14,
                refresh=False,
            )
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
        return {"answer": answer, "assistant": saved, "retrieval": safe_retrieval}

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
            "inline_index_refresh": False,
            "background_task": SEMANTIC_TASK_TYPE,
        }
        return payload

    def run_with_semantic(manager: Any, project_id: str, task_id: str) -> None:
        config = manager.project_loader(project_id)
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return original_run(manager, project_id, task_id)
        if str(task.get("type", "") or "") != SEMANTIC_TASK_TYPE:
            return original_run(manager, project_id, task_id)

        try:
            manager._update(config, task_id, status="running", stage="starting", message="语义索引任务开始")
            if manager._cancel_requested(config, task_id):
                manager._update(config, task_id, status="cancelled", stage="cancelled", message="语义索引任务已取消")
                return
            group_ids, sources = _semantic_task_targets(task)
            indexer = ProjectSemanticIndexer(
                str(getattr(manager, "workspace_id", "") or ""),
                project_id,
                config,
            )
            last_progress = {"done": -1, "source": ""}

            def report(done: int, total: int, source: str) -> None:
                if done == last_progress["done"] and source == last_progress["source"]:
                    return
                last_progress["done"] = done
                last_progress["source"] = source
                label = {
                    "visual": "画面",
                    "speech": "对白",
                    "slate": "场记",
                    "preparing": "准备",
                }.get(source, source or "索引")
                manager._update(
                    config,
                    task_id,
                    stage="semantic_index",
                    progress={"done": done, "total": total},
                    message=f"语义索引 {done}/{total} · {label}",
                )

            def execute() -> dict[str, Any]:
                return refresh_semantic_index_background(
                    indexer,
                    group_ids=group_ids,
                    sources=sources,
                    progress=report,
                    cancelled=lambda: manager._cancel_requested(config, task_id),
                )

            resource = getattr(manager, "_resource", None)
            if callable(resource):
                with resource(config, task, "embedding", "semantic_index", "语义索引"):
                    result = execute()
            else:
                result = execute()

            if result.get("cancelled") or manager._cancel_requested(config, task_id):
                manager._update(
                    config,
                    task_id,
                    status="cancelled",
                    stage="cancelled",
                    result=result,
                    message="语义索引已取消；已完成的文本索引和向量继续可用",
                )
                return
            if result.get("embedding_failed"):
                raise RuntimeError("语义向量编码失败；文本索引仍可用，可在状态中心重试")
            manager._update(
                config,
                task_id,
                status="completed",
                stage="completed",
                result=result,
                message="语义索引任务完成",
            )
        except Exception as error:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error=str(error),
                message="语义索引任务失败",
            )
        finally:
            try:
                manager._threads.pop(task_id, None)
            except Exception:
                pass

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
        try:
            manager.submit(
                project_id,
                SEMANTIC_TASK_TYPE,
                targets={"group_ids": group_ids, "sources": sorted(SEMANTIC_SOURCES)},
                idempotency_key=_semantic_task_key(
                    project_id,
                    reason="after-task",
                    groups=group_ids or None,
                    suffix=task_id,
                ),
                actor="system",
            )
        except Exception:
            return

    def maybe_schedule_bootstrap(service: Any, project_id: str, payload: dict[str, Any]) -> None:
        summary = _as_dict(payload.get("summary"))
        documents = int(summary.get("documents", 0) or 0)
        vectors = int(summary.get("vectors", 0) or 0)
        embedding = SemanticEmbeddingConfig.from_env()
        needs_documents = documents <= 0
        needs_vectors = embedding.enabled and vectors < documents
        if not needs_documents and not needs_vectors:
            return
        project = service.project(project_id)
        revision = str(getattr(project, "analysis_revision", "") or "")
        suffix = f"{revision}:{documents}:{vectors}:{embedding.identity}"
        try:
            service.tasks.submit(
                project_id,
                SEMANTIC_TASK_TYPE,
                targets={"sources": sorted(SEMANTIC_SOURCES)},
                idempotency_key=_semantic_task_key(project_id, reason="search-bootstrap", suffix=suffix),
                actor="system",
            )
        except Exception:
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
                    )
                    maybe_schedule_bootstrap(service, project_id, payload)
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
    tasks_module.TaskManager._run = run_with_semantic
    tasks_module.TaskManager._update = update_with_semantic
    _INSTALLED = True
