from __future__ import annotations

import sqlite3
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import parse_qs

from .semantic_encoder import SemanticEmbeddingConfig
from .semantic_index import ProjectSemanticIndexer, SEMANTIC_SOURCES
from .semantic_search import SemanticSearcher, safe_search_payload
from .vision_provider import VisionProviderConfig


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


def _searcher(service: Any, project_id: str, *, read_only: bool = False) -> SemanticSearcher:
    project = service.project(project_id)
    workspace = _workspace_for_service(service)
    return SemanticSearcher(workspace.workspace_id, project_id, project.config, read_only=read_only)


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


def _append_filename_matches(project: Any, payload: dict[str, Any], text: str, limit: int) -> None:
    """Search existing clip names even when no semantic index has been built."""
    results = payload["results"]
    matched_clips = {row.get("clip_id") for row in results}
    needle = text.casefold()
    for clip in project.index.get("clips", []):
        if len(results) >= limit:
            break
        if not isinstance(clip, dict):
            continue
        clip_id = clip.get("clip_id")
        name = PurePosixPath(str(clip.get("name") or "").replace(chr(92), "/")).name
        if not clip_id or clip_id in matched_clips or not name or needle not in name.casefold():
            continue
        results.append({
            "document_id": f"file:{clip_id}", "group_id": "", "clip_id": clip_id,
            "media_id": str(clip.get("media_id") or ""), "source": "file", "source_label": "文件名",
            "score": 0.0, "keyword_rank": None, "vector_rank": None, "vector_similarity": None,
            "start": 0.0, "end": 0.0, "snippet": name,
            "metadata": {"file_name": name, "camera": str(clip.get("camera") or "")},
        })
        matched_clips.add(clip_id)
    payload["summary"]["returned"] = len(results)


def answer_project_question(self: Any, message: str, *, context: dict | None = None) -> dict[str, Any]:
    text = str(message or "").strip()[:3000]
    if not text:
        raise ValueError("消息不能为空")
    context = context or {}
    selection = context.get("selection", {})
    facts = context.get("facts", {})
    diagnosis = context.get("diagnosis")
    receipt = {key: context[key] for key in ("project_id", "page", "label", "selection", "analysis_revision") if key in context}
    project_question = not selection or "项目" in text or "工程" in text
    diagnostics_question = diagnosis and project_question and any(
        term in text for term in ("同步", "交付", "能交", "不能交", "卡", "取消", "停在", "阻塞", "重连", "目录")
    )
    self.store.append_message("user", text, source="user", context=receipt)
    retrieval = {"contract": "semantic_search.v1", "query": text, "mode": "unavailable",
                 "results": [], "summary": {}, "semantics": {"read_only": True}}
    if diagnostics_question:
        answer = diagnosis["summary"]
    else:
        try:
            searcher = SemanticSearcher(self.workspace_id, self.project_id, self.config, read_only=True)
            retrieval = safe_search_payload(searcher.search(text, limit=14, refresh=False, selection=selection))
        except (OSError, ValueError, RuntimeError, sqlite3.Error):
            pass
        if selection:
            group = selection.get("group_id")
            notes = self._supervisor_notes(group=group) if group else []
            model_facts = {"selected_material": facts, "selection": selection, "take_slate": notes}
        else:
            notes = self._supervisor_notes(limit=36)
            model_facts = {"project": self.tools.inspect_project(), "attention": self.tools.list_attention_groups(limit=12),
                           "script_supervisor": notes[:20], "assistant_summary": self.status().get("summary", "")}
        answer = ""
        has_evidence = retrieval["results"] or notes or facts.get("script_text") or model_facts.get("attention")
        if self.language.enabled and (not context or has_evidence):
            raw = self.language.complete_json(
                system=(
                    "你是小镜，服务短剧后期制作。按提问时的选区、已记录的同步状态、画面、实际对白和人工场记回答。"
                    "缺少证据就说明缺什么。剧本正文与实拍对白分开。不要推测说话人、精确可用时段或画面错帧数。"
                    "整组 Take 的场记或画面只能按整组引用。场记和候选不能升级成最终归属或 Best/Reject。不要声称执行了未发生的动作。"
                    '输出严格JSON：{"answer":"中文回答"}。'
                ),
                context={"question": text, "semantic_retrieval": retrieval, **model_facts, "delivery_status": diagnosis},
                temperature=0.15,
            )
            answer = str(_as_dict(raw).get("answer") or "").strip()
        if not answer:
            if selection:
                lines = [context["label"]]
                if facts.get("position_note"):
                    lines.append(facts["position_note"])
                if facts.get("source_timecode"):
                    lines.append(f"源起始时间码 {facts['source_timecode']}。")
                media_state = {"verified": "本机素材已验证。", "missing": "本机已登记的素材缺失。", "unknown": "本机素材绑定待核对。"}
                if facts.get("media_state") in media_state:
                    lines.append(media_state[facts["media_state"]])
                if facts.get("script_text"):
                    lines.append(f"剧本原文：{facts['script_text']}")
                if notes and notes[0].get("note"):
                    lines.append(f"人工场记：{notes[0]['note']}")
                if retrieval["results"]:
                    lines.append(_deterministic_answer(text, retrieval))
                else:
                    lines.append("当前选区没有可引用的画面、转写或场记索引。")
                answer = "\n".join(lines)
            elif diagnosis and not retrieval["results"]:
                answer = diagnosis["summary"] + "\n当前问题没有检索到相关的画面、对白或场记证据。"
            else:
                answer = _deterministic_answer(text, retrieval)
    saved = self.store.append_message("assistant", answer, source=self.models.assistant.source, context=receipt)
    return {"answer": answer, "assistant": saved, "retrieval": retrieval,
            **({"context": receipt} if receipt else {}),
            **({"diagnosis": diagnosis} if diagnosis and (not selection or diagnostics_question) else {})}


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
            "visual_providers": {
                "local_vision": {
                    "configured": VisionProviderConfig.from_env().is_local,
                    "evidence_only": True,
                    "requires_explicit_task": True,
                }
            },
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
                    payload = _searcher(service, project_id, read_only=True).search(
                        text,
                        limit=limit,
                        sources=sources,
                        refresh=False,
                        allow_query_embedding=False,
                    )
                    if not sources:
                        _append_filename_matches(service.project(project_id), payload, text, limit)
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
                        _searcher(service, project_id, read_only=True).search(
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
    AssistantOrchestrator.answer = answer_project_question
    web_server.WorkspaceService.capabilities = capabilities_with_semantic
    web_server.make_handler = make_handler_with_semantic
    tasks_module.TaskManager._run = run_with_semantic
    tasks_module.TaskManager._update = update_with_semantic
    _INSTALLED = True
