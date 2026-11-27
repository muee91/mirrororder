from __future__ import annotations

from collections import OrderedDict
import copy
import json
from pathlib import Path
from threading import Lock, Thread
from typing import Any

from .script_supervisor_parser import parse_supervisor_text
from .script_supervisor_store import SUPERVISOR_CONTRACT, ScriptSupervisorConflictError, ScriptSupervisorStore

_INSTALLED = False
_PAPER_SUGGESTION_CACHE_LOCK = Lock()
_PAPER_SUGGESTION_CACHE: OrderedDict[tuple[Any, ...], dict[str, Any] | None] = OrderedDict()
_PAPER_SUGGESTION_CACHE_MAX = 64


def _file_signature(path: Path) -> tuple[int, int] | None:
    try:
        info = path.stat()
    except OSError:
        return None
    return (info.st_mtime_ns, info.st_size)


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_automatic_state(value: object) -> dict[str, Any]:
    """Keep review.v1 structurally decodable even when automation has no row.

    The native App decodes the whole review model atomically. A single sparse
    ``{"available": false}`` object must therefore never make the entire
    project unreadable. Unknown/additional fields are preserved by the Host
    upstream; this projection only guarantees the stable core fields used by
    native Production.
    """
    raw = _as_dict(value)
    episode_ids: list[int] = []
    for item in _as_list(raw.get("episode_ids")):
        try:
            number = int(item)
        except (TypeError, ValueError):
            continue
        if number > 0 and number not in episode_ids:
            episode_ids.append(number)
    return {
        **raw,
        "available": bool(raw.get("available", bool(raw))),
        "status": str(raw.get("status", "") or ""),
        "reason": str(raw.get("reason", "") or ""),
        "confidence": _safe_float(raw.get("confidence"), 0.0),
        "episode_ids": sorted(episode_ids),
    }


def _safe_entry(value: object) -> dict[str, Any]:
    raw = _as_dict(value)
    if not raw:
        return {}
    usable_range = _as_dict(raw.get("usable_range")); angles = _as_dict(raw.get("angles"))
    return {
        "group_id": str(raw.get("group_id", "") or ""),
        "script_scene_id": str(raw.get("script_scene_id", "") or "")[:160],
        "episode": raw.get("episode"),
        "scene": str(raw.get("scene", "") or "")[:80], "shot": str(raw.get("shot", "") or "")[:80],
        "take_number": raw.get("take_number"), "status": str(raw.get("status", "unmarked") or "unmarked"),
        "note": str(raw.get("note", "") or "")[:2000],
        "usable_range": {"start": usable_range.get("start"), "end": usable_range.get("end")} if usable_range else {},
        "preferred_clip_id": str(raw.get("preferred_clip_id", "") or "")[:160],
        "angles": {str(clip_id): {"shot_type": str(_as_dict(row).get("shot_type", "unknown") or "unknown"), "note": str(_as_dict(row).get("note", "") or "")[:500]} for clip_id, row in angles.items() if isinstance(row, dict)},
        "actor": str(raw.get("actor", "") or "")[:80], "updated_at": str(raw.get("updated_at", "") or "")[:80],
    }


def _safe_attachment(value: object) -> dict[str, Any]:
    raw = _as_dict(value)
    return {"clip_id": str(raw.get("clip_id", "") or "")[:160], "media_id": str(raw.get("media_id", "") or "")[:160], "camera": str(raw.get("camera", "") or "")[:40], "display_name": Path(str(raw.get("display_name", "") or "")).name[:300], "shot_type": str(raw.get("shot_type", "unknown") or "unknown")[:40], "source_role": str(raw.get("source_role", "sync_camera") or "sync_camera")[:40], "note": str(raw.get("note", "") or "")[:500]}


def _safe_record(value: object) -> dict[str, Any]:
    raw = _as_dict(value)
    if not raw:
        return {}
    usable_range = _as_dict(raw.get("usable_range"))
    return {
        "record_id": str(raw.get("record_id", "") or "")[:160], "source_group_id": str(raw.get("source_group_id", "") or "")[:160],
        "script_scene_id": str(raw.get("script_scene_id", "") or "")[:160], "episode": raw.get("episode"),
        "scene": str(raw.get("scene", "") or "")[:80], "shot": str(raw.get("shot", "") or "")[:80], "take_number": raw.get("take_number"),
        "status": str(raw.get("status", "unmarked") or "unmarked"), "note": str(raw.get("note", "") or "")[:2000],
        "usable_range": {"start": usable_range.get("start"), "end": usable_range.get("end")} if usable_range else {},
        "preferred_clip_id": str(raw.get("preferred_clip_id", "") or "")[:160],
        "attachments": [_safe_attachment(row) for row in _as_list(raw.get("attachments")) if isinstance(row, dict)][:32],
        "actor": str(raw.get("actor", "") or "")[:80], "updated_at": str(raw.get("updated_at", "") or "")[:80],
    }


def _safe_paper_suggestions(value: object) -> dict[str, Any] | None:
    raw = _as_dict(value)
    if raw.get('contract') != 'mirrororder.paper_field_suggestions.v1' or raw.get('editorial_authority') is not False:
        return None
    groups: dict[str, dict[str, Any]] = {}
    for group_id, item in _as_dict(raw.get('groups')).items():
        if len(groups) >= 1200 or not isinstance(group_id, str) or not isinstance(item, dict):
            continue
        fields: dict[str, dict[str, str]] = {}
        for field in ('scene', 'shot', 'take'):
            reading = item.get('fields', {}).get(field) if isinstance(item.get('fields'), dict) else None
            if isinstance(reading, dict) and reading.get('state') == 'suggested' and isinstance(reading.get('value'), str):
                fields[field] = {'state': 'suggested', 'value': reading['value'][:80]}
        source = item.get('source') if isinstance(item.get('source'), dict) else {}
        if not fields or not isinstance(source.get('paper_row_id'), str) or not isinstance(source.get('row_digest'), str):
            continue
        groups[group_id] = {
            'state': 'paper_suggestion',
            'fields': fields,
            'source': {
                'pdf_sha256': str(source.get('pdf_sha256', '') or '')[:64],
                'pdf_page': source.get('pdf_page'),
                'row_index': source.get('row_index'),
                'paper_row_id': source['paper_row_id'][:160],
                'row_digest': source['row_digest'][:64],
            },
            'human_confirmed': False,
            'source_interval_verified': False,
        }
    return {
        'contract': 'mirrororder.paper_field_suggestions.v1',
        'editorial_authority': False,
        'paper_revision': int(raw.get('paper_revision', 0) or 0),
        'groups': groups,
    }


def _paper_suggestions(service: Any, project_id: str, project: Any) -> dict[str, Any] | None:
    try:
        from .paper_intake_store import PaperIntakeStore
        from .slate_field_suggestions import read_algorithmic_suggestions

        output = Path(project.config.output_dir)
        suggestions_sig = _file_signature(output / 'paper_field_suggestions.v1.json')
        if suggestions_sig is None:
            return None
        report_path = output / 'sync' / 'sync_report.json'
        report_sig = _file_signature(report_path)
        if report_sig is None:
            return None
        cache_key = (
            str(output.resolve()),
            str(project_id),
            str(getattr(project, 'analysis_revision', '') or ''),
            suggestions_sig,
            _file_signature(output / 'paper_intake.json'),
            report_sig,
            _file_signature(output / 'material_index.json'),
        )
        with _PAPER_SUGGESTION_CACHE_LOCK:
            if cache_key in _PAPER_SUGGESTION_CACHE:
                _PAPER_SUGGESTION_CACHE.move_to_end(cache_key)
                cached = _PAPER_SUGGESTION_CACHE[cache_key]
                return copy.deepcopy(cached) if cached is not None else None
        report = json.loads(report_path.read_text(encoding='utf-8'))
        index = project.index if isinstance(project.index, dict) else {}
        groups = index.get('groups', []) if isinstance(index.get('groups'), list) else []
        proposal = read_algorithmic_suggestions(
            output,
            project_id,
            PaperIntakeStore(output, project_id),
            index,
            report,
            groups,
        )
        safe = _safe_paper_suggestions(proposal)
        with _PAPER_SUGGESTION_CACHE_LOCK:
            _PAPER_SUGGESTION_CACHE[cache_key] = copy.deepcopy(safe) if safe is not None else None
            _PAPER_SUGGESTION_CACHE.move_to_end(cache_key)
            while len(_PAPER_SUGGESTION_CACHE) > _PAPER_SUGGESTION_CACHE_MAX:
                _PAPER_SUGGESTION_CACHE.popitem(last=False)
        return safe
    except (OSError, ValueError, TypeError, KeyError, AttributeError, json.JSONDecodeError):
        return None


def _safe_board(payload: dict[str, Any], paper_suggestions: object = None) -> dict[str, Any]:
    entries = payload.get("entries", {}) if isinstance(payload.get("entries"), dict) else {}
    records = payload.get("records", {}) if isinstance(payload.get("records"), dict) else {}
    result = {
        "version": int(payload.get("version", 2) or 2), "contract": str(payload.get("contract", SUPERVISOR_CONTRACT) or SUPERVISOR_CONTRACT),
        "revision": int(payload.get("revision", 0) or 0), "updated_at": str(payload.get("updated_at", "") or ""),
        "records": {str(record_id): _safe_record(row) for record_id, row in records.items() if isinstance(row, dict)},
        "entries": {str(group_id): _safe_entry(row) for group_id, row in entries.items() if isinstance(row, dict)},
        "semantics": {"record_is_primary_identity": True, "record_may_exist_without_take": True, "attachments_use_clip_or_media_identity": True, "human_scene_text_is_not_script_scene_id": True, "device_paths_exposed": False, "editorial_authority": False},
    }
    safe_paper = _safe_paper_suggestions(paper_suggestions)
    if safe_paper is not None:
        result['paper_suggestions'] = safe_paper
    return result


def _refresh_assistant(service: Any, project_id: str) -> None:
    try:
        from .assistant_runtime import _orchestrator
        Thread(target=lambda: _orchestrator(service, project_id).cycle(trigger="script-supervisor", allow_actions=False), daemon=True, name=f"mirror-assistant-supervisor-{project_id}").start()
    except Exception:
        pass


def install_script_supervisor_runtime() -> None:
    """Install the electronic slate as human production evidence, never editorial authority."""
    global _INSTALLED
    if _INSTALLED:
        return
    from . import review_read_model, web_server

    original_build = review_read_model.build_review_read_model
    original_state = web_server.ProjectService.state
    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler

    def build_with_supervisor(project: Any, **kwargs: Any) -> dict[str, Any]:
        payload = original_build(project, **kwargs); store = ScriptSupervisorStore(project.config.output_dir); board = store.load()
        entries = board.get("entries", {}) if isinstance(board.get("entries"), dict) else {}
        for take in payload.get("take_groups", []):
            if isinstance(take, dict):
                group_id = str(take.get("group_id", "") or "")
                take["automatic_state"] = _safe_automatic_state(take.get("automatic_state"))
                take["script_supervisor"] = _safe_entry(entries.get(group_id))
        payload.setdefault("revisions", {})["script_supervisor"] = int(board.get("revision", 0) or 0)
        payload.setdefault("capabilities", {}).update({"script_supervisor_v2": True, "script_supervisor_record_model": True, "script_supervisor_write_scope": "host_local", "script_supervisor_is_editorial_authority": False})
        payload.setdefault("summary", {})["script_supervisor"] = store.summary()
        return payload

    def state_with_supervisor(project: Any) -> dict[str, Any]:
        payload = original_state(project); store = ScriptSupervisorStore(project.config.output_dir); board = store.load()
        payload["script_supervisor_revision"] = int(board.get("revision", 0) or 0); payload["script_supervisor_updated_at"] = str(board.get("updated_at", "") or ""); payload["script_supervisor_summary"] = store.summary(); return payload

    def capabilities_with_supervisor(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["script_supervisor"] = {"contract": SUPERVISOR_CONTRACT, "read": True, "agent_write": False, "app_write": True, "record_model": True, "natural_language_parse": True, "standalone_media_rows": True, "editorial_authority": False}
        return payload

    def make_handler_with_supervisor(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)
        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "script-supervisor":
                    self._local_only(); project = service.project(parts[3]); self._send_json(_safe_board(ScriptSupervisorStore(project.config.output_dir).load(), _paper_suggestions(service, parts[3], project))); return
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "script-supervisor-paper":
                    from .paper_intake_store import PaperIntakeStore
                    self._local_only(); project = service.project(parts[3])
                    self._send_json(PaperIntakeStore(project.config.output_dir, parts[3]).read_model()); return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"]:
                    project_id = parts[3]
                    if parts[4] == "script-supervisor":
                        self._local_only()
                        if hasattr(self, "_require_host_local"):
                            self._require_host_local()
                        body = web_server._body(self)
                        if "expected_workspace_id" in body and body["expected_workspace_id"] != service.workspace.workspace_id:
                            raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, "场记写入的工作区已变化，请重新连接")
                        project = service.project(project_id)
                        store = ScriptSupervisorStore(project.config.output_dir)
                        try:
                            if body.get("action") in {"upsert_record", "delete_record"} or "record" in body:
                                saved = store.apply_record({**body, "delete": body.get("action") == "delete_record" or bool(body.get("delete"))})
                            else:
                                saved = store.apply(body)
                        except ScriptSupervisorConflictError as error:
                            raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                        except ValueError as error:
                            raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                        self._send_json(_safe_board(saved, _paper_suggestions(service, project_id, project))); _refresh_assistant(service, project_id)
                        # 场记是语义索引的 slate 证据源；写入后刷新对应 Take 的
                        # 索引，否则语义搜索永远看不到最新的人工事实。刷新失败
                        # 不影响场记写入本身（Status Center 可观察/重试）。
                        record = body.get("record") if isinstance(body.get("record"), dict) else {}
                        group_id = str(record.get("source_group_id", "") or "")
                        targets = {"sources": ["slate"], **({"group_ids": [group_id]} if group_id else {})}
                        try:
                            service.tasks.submit(
                                project_id,
                                "semantic_index",
                                targets,
                                idempotency_key=f"semantic-refresh:supervisor:{int(saved.get('revision', 0) or 0)}",
                                actor="system",
                            )
                        except Exception:
                            pass
                        return
                    if parts[4] == "script-supervisor-parse":
                        self._local_only(); (self._require_host_local() if hasattr(self, "_require_host_local") else None); project = service.project(project_id); body = web_server._body(self)
                        if body.get("operation") == "ingest":
                            from .paper_intake_store import PaperIntakeStore
                            from .scene_interval_store import IntervalConflict
                            try:
                                result = PaperIntakeStore(project.config.output_dir, project_id).ingest(body)
                            except IntervalConflict as error:
                                raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                            except (ValueError, TypeError) as error:
                                raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                            self._send_json(result); return
                        if body.get("mode") is not None:
                            from .slate_log_intake import prepare_project_request
                            try:
                                proposal = prepare_project_request(body, project.index, ScriptSupervisorStore(project.config.output_dir).load())
                            except (ValueError, TypeError) as error:
                                raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                            self._send_json(proposal); return
                        text = str(body.get("text", "") or "").strip()
                        if not text:
                            raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "快速录入内容不能为空")
                        parsed_result = parse_supervisor_text(text, previous=_as_dict(body.get("previous")), allow_model=bool(body.get("allow_model", True)))
                        self._send_json({"contract": "script_supervisor_parse.v1", "input": text[:2000], "result": parsed_result}); return
                return super()._app_post(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 6 and parts[:4] == ["api", "agent", "v1", "projects"] and parts[5] == "script-supervisor":
                    project_id = parts[4]; agent = self._agent("read", project_id); project = service.project(project_id); service.tokens.audit(agent, "read:script-supervisor", project_id)
                    self._send_json(_safe_board(ScriptSupervisorStore(project.config.output_dir).load(), _paper_suggestions(service, project_id, project))); return
                return super()._agent_get(parsed)
        return Handler

    # Assistant tools consume the same human notes. They may explain or plan
    # around them, but this wrapper grants no new write action.
    try:
        from . import agent_tools
        original_inspect_project = agent_tools.AgentToolRegistry.inspect_project
        original_inspect_take = agent_tools.AgentToolRegistry.inspect_take

        def inspect_project_with_slate(tool: Any) -> dict[str, Any]:
            payload = original_inspect_project(tool)
            payload["script_supervisor"] = ScriptSupervisorStore(tool.config.output_dir).summary()
            return payload

        def inspect_take_with_slate(tool: Any, group_id: str) -> dict[str, Any]:
            payload = original_inspect_take(tool, group_id)
            payload["script_supervisor"] = _safe_record(ScriptSupervisorStore(tool.config.output_dir).record_for_group(group_id))
            return payload

        agent_tools.AgentToolRegistry.inspect_project = inspect_project_with_slate
        agent_tools.AgentToolRegistry.inspect_take = inspect_take_with_slate
    except Exception:
        pass

    review_read_model.build_review_read_model = build_with_supervisor
    web_server.ProjectService.state = state_with_supervisor
    web_server.WorkspaceService.capabilities = capabilities_with_supervisor
    web_server.make_handler = make_handler_with_supervisor
    _INSTALLED = True
