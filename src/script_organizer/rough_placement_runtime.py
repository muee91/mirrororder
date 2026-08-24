from __future__ import annotations

from pathlib import Path
from typing import Any

from .rough_placement import parse_rough_placement_text, resolve_rough_plans


_INSTALLED = False


def install_rough_placement_runtime() -> None:
    """Expose a Host-local coarse placement route for approximate slate notes.

    The route writes only episode-level human placement. It never invents scene
    or script-segment ids. Preview is read-only; apply requires an explicit
    ``confirm`` flag and a human actor, then uses ReviewStore.apply_actions so a
    whole handwritten range batch lands under one review revision.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    original_make_handler = web_server.make_handler

    def make_handler_with_rough_placement(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "rough-placement"
                ):
                    self._local_only()
                    project_id = parts[3]
                    project = service.project(project_id)
                    body = web_server._body(self)
                    text = str(body.get("text", "") or "").strip()
                    if not text:
                        raise web_server.ApiError(
                            web_server.HTTPStatus.BAD_REQUEST,
                            "粗归集内容不能为空",
                        )
                    try:
                        plans = parse_rough_placement_text(text)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    if not plans:
                        raise web_server.ApiError(
                            web_server.HTTPStatus.BAD_REQUEST,
                            "没有识别到 Take 范围和集数。示例：1-10 第1集；11-20 第2集",
                        )

                    resolved = resolve_rough_plans(
                        plans,
                        [row for row in project.index.get("groups", []) if isinstance(row, dict)],
                    )
                    response = {
                        "contract": "rough_placement.v1",
                        "text": text[:4000],
                        **resolved,
                        "requires_confirmation": True,
                        "applied": False,
                    }
                    if not bool(body.get("confirm", False)):
                        self._send_json(response)
                        return

                    actor = self._review_actor(body.get("actor"))
                    if not actor:
                        raise web_server.ApiError(
                            web_server.HTTPStatus.BAD_REQUEST,
                            "确认粗归集需要操作者昵称",
                        )
                    actions: list[dict[str, Any]] = []
                    for assignment in resolved["plans"]:
                        episode = int(assignment["episode"])
                        for group_id in assignment["group_ids"]:
                            actions.append(
                                {
                                    "action": "set_group_placement",
                                    "group_id": str(group_id),
                                    "episode_ids": [episode],
                                    "script_segment_ids": [],
                                    "actor": actor,
                                    "interaction": "rough_batch",
                                    "source_surface": "native_app",
                                    "source_kind": "take",
                                }
                            )
                    if not actions:
                        raise web_server.ApiError(
                            web_server.HTTPStatus.BAD_REQUEST,
                            "这些 Take 序号在当前项目里都不存在",
                        )
                    try:
                        saved = project.review.apply_actions(actions)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    response.update(
                        {
                            "applied": True,
                            "requires_confirmation": False,
                            "review_revision": int(saved.get("revision", 0) or 0),
                        }
                    )
                    self._send_json(response)
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_rough_placement
    _INSTALLED = True


__all__ = ["install_rough_placement_runtime"]
