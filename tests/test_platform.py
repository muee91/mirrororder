from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from script_organizer.agent_store import AgentAuthorizationError, AgentTokenStore, ProposalStore
from script_organizer.config import ProjectConfig
from script_organizer.material_index import analyze
from script_organizer.media_reader import read_media_directory
from script_organizer.mcp_server import GatewayClient, _tool_call
from script_organizer.review_store import ReviewStore
from script_organizer.script_parser import parse_script
from script_organizer.tasks import TaskManager
from script_organizer.web_server import (
    GatewaySecurity,
    WorkspaceGateway,
    WorkspaceService,
    make_gateway_handler,
    make_handler,
)
from script_organizer.workspace import WorkspaceConfig, WorkspaceRegistry


def _workspace(tmp_path: Path) -> WorkspaceConfig:
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (tmp_path / "workspace.toml").write_text(
        "[workspace]\nname='test workspace'\nregistry='./projects/registry.json'\nweb_directory='./web'\n",
        encoding="utf-8",
    )
    (tmp_path / "projects").mkdir()
    (tmp_path / "projects" / "registry.json").write_text('{"version":1,"projects":[]}', encoding="utf-8")
    return WorkspaceConfig.from_file(tmp_path / "workspace.toml")


def _project_files(tmp_path: Path, name: str = "Demo") -> tuple[Path, Path, Path]:
    media = tmp_path / "A001.mp4"
    media.write_bytes(b"video")
    fcpxml = tmp_path / "input.fcpxml"
    fcpxml.write_text(
        f"""<fcpxml version="1.8"><resources><asset id="a" src="file://{media}"/></resources>
        <library><event><project><sequence><spine>
        <asset-clip name="A001" ref="a" lane="1" offset="0s" duration="3s"/>
        </spine></sequence></project></event></library></fcpxml>""",
        encoding="utf-8",
    )
    script = tmp_path / "script.md"
    script.write_text("# 第1集\n\n1-1 室内\n\n小王：你好\n", encoding="utf-8")
    return media, fcpxml, script


def _register_demo(workspace: WorkspaceConfig, tmp_path: Path, project_id: str = "demo") -> Path:
    _media, fcpxml, script = _project_files(tmp_path)
    project_dir = workspace.registry_path.parent / project_id
    project_dir.mkdir()
    config = project_dir / "project.toml"
    config.write_text(
        f"""[project]
name = "Demo"
[input]
kind = "fcpxml"
fcpxml = "{fcpxml}"
script = "{script}"
[output]
directory = "./output"
[asr]
backend = "cache"
transcript_dir = "./cache/transcripts"
""",
        encoding="utf-8",
    )
    WorkspaceRegistry(workspace).register_existing(project_id, config)
    analyze(ProjectConfig.from_file(config))
    return config


def _request(base: str, path: str, token: str = "", method: str = "GET", payload: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={
            **({"Authorization": "Bearer " + token} if token else {}),
            **({"Content-Type": "application/json"} if data else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def _head_request(base: str, path: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(base + path, method="HEAD", headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()


def test_workspace_registry_preflights_fcpxml_and_media_directory(tmp_path):
    workspace = _workspace(tmp_path)
    registry = WorkspaceRegistry(workspace)
    media, fcpxml, script = _project_files(tmp_path)
    created = registry.create({
        "name": "FCP 项目",
        "project_id": "fcpxml-demo",
        "input_kind": "fcpxml",
        "fcpxml": str(fcpxml),
        "script": str(script),
    })
    assert created["project_id"] == "fcpxml-demo"
    media_root = tmp_path / "media"
    media_root.mkdir()
    (media_root / media.name).write_bytes(media.read_bytes())
    directory = registry.create({
        "name": "目录项目",
        "project_id": "directory-demo",
        "input_kind": "media-directory",
        "media_root": str(media_root),
        "script": str(script),
        "camera_patterns": {"A": "^A"},
    })
    config = registry.project_config(directory["project_id"])
    assert config.is_media_directory and config.media_root == media_root
    assert read_media_directory(media_root, config.camera_patterns)[0].camera == "A"


def test_script_parser_supports_txt_and_markdown(tmp_path):
    for suffix in (".txt", ".md"):
        script = tmp_path / f"script{suffix}"
        script.write_text("第2集\n2-1 门口\n小王：今天到了\n", encoding="utf-8")
        segments = parse_script(script).segments
        assert any(segment.episode == 2 and segment.type == "dialogue" for segment in segments)


def test_agent_tokens_proposals_and_atomic_review_revision(tmp_path):
    workspace = _workspace(tmp_path)
    config_path = _register_demo(workspace, tmp_path)
    config = ProjectConfig.from_file(config_path)
    index = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    script = json.loads((config.output_dir / "script.json").read_text(encoding="utf-8"))
    group = index["groups"][0]
    segment = script["segments"][0]
    tokens = AgentTokenStore(workspace)
    _record, token = tokens.create("test-agent", ["demo"], ["read", "propose"], 1)
    assert tokens.authorize(token, "read", "demo")["name"] == "test-agent"
    with pytest.raises(AgentAuthorizationError):
        tokens.authorize("bad", "read", "demo")

    proposals = ProposalStore(config.output_dir)
    review = ReviewStore(config.output_dir / "review.json")
    proposal = proposals.create(
        {
            "group_id": group["group_id"],
            "episode_ids": [1],
            "script_segment_ids": [segment["segment_id"]],
            "evidence": [{
                "clip_id": group["members"][0]["clip_id"],
                "start": 0,
                "end": 1,
                "summary": "ASR 与剧本首句一致",
            }],
            "base_analysis_revision": "a1",
            "base_review_revision": 0,
        },
        tokens.authorize(token, "propose", "demo"),
        {group["group_id"]: group},
        {segment["segment_id"]: segment},
        "a1",
        0,
    )
    applied = proposals.apply(
        [proposal["proposal_id"]],
        "审核人",
        {group["group_id"]: group},
        {segment["segment_id"]: segment},
        "a1",
        review,
    )
    assert applied[0]["status"] == "applied"
    assert review.load()["revision"] == 1
    assert review.load()["placements"][group["group_id"]]["actor"] == "审核人"


def test_proposal_rejects_stale_review_revision_and_invalid_evidence(tmp_path):
    workspace = _workspace(tmp_path)
    config_path = _register_demo(workspace, tmp_path)
    config = ProjectConfig.from_file(config_path)
    index = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    script = json.loads((config.output_dir / "script.json").read_text(encoding="utf-8"))
    group = index["groups"][0]
    segment = script["segments"][0]
    proposals = ProposalStore(config.output_dir)
    review = ReviewStore(config.output_dir / "review.json")
    with pytest.raises(ValueError, match="证据"):
        proposals.create(
            {
                "group_id": group["group_id"],
                "episode_ids": [1],
                "evidence": [{"clip_id": "wrong", "summary": "wrong"}],
                "base_analysis_revision": "a1",
                "base_review_revision": 0,
            },
            {"token_id": "a", "name": "agent"},
            {group["group_id"]: group},
            {segment["segment_id"]: segment},
            "a1",
            0,
        )
    proposal = proposals.create(
        {
            "group_id": group["group_id"],
            "episode_ids": [1],
            "script_segment_ids": [segment["segment_id"]],
            "evidence": [{"clip_id": group["members"][0]["clip_id"], "start": 0, "end": 1, "summary": "可复核证据"}],
            "base_analysis_revision": "a1",
            "base_review_revision": 0,
        },
        {"token_id": "a", "name": "agent"},
        {group["group_id"]: group},
        {segment["segment_id"]: segment},
        "a1",
        0,
    )
    review.apply_action({"action": "set_group", "group_id": "another", "state": "keep", "actor": "other"})
    with pytest.raises(ValueError, match="人工审核版本"):
        proposals.apply(
            [proposal["proposal_id"]],
            "审核人",
            {group["group_id"]: group},
            {segment["segment_id"]: segment},
            "a1",
            review,
        )


def test_task_targets_only_affected_groups_and_is_idempotent(tmp_path, monkeypatch):
    workspace = _workspace(tmp_path)
    config_path = _register_demo(workspace, tmp_path)
    config = ProjectConfig.from_file(config_path)
    index = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    group = index["groups"][0]
    calls = []

    def fake_analyze(project_config, affected_group_ids=None):
        calls.append((project_config.config_path, affected_group_ids))
        return {"index": {"stats": {"analysis_cache_recomputed_groups": len(affected_group_ids or [])}}}

    monkeypatch.setattr("script_organizer.tasks.analyze", fake_analyze)
    manager = TaskManager(lambda project_id: config if project_id == "demo" else (_ for _ in ()).throw(KeyError(project_id)))
    task = manager.submit(
        "demo",
        "incremental_analyze",
        {"clip_ids": [group["members"][0]["clip_id"]]},
        "same-key",
    )
    duplicate = manager.submit(
        "demo",
        "incremental_analyze",
        {"clip_ids": [group["members"][0]["clip_id"]]},
        "same-key",
    )
    assert duplicate["task_id"] == task["task_id"]
    manager._threads[task["task_id"]].join(timeout=3)
    assert calls == [(config.config_path, {group["group_id"]})]
    assert manager.list("demo")[0]["status"] == "completed"


def test_agent_gateway_has_versioned_routes_and_enforces_auth(tmp_path):
    workspace = _workspace(tmp_path)
    _register_demo(workspace, tmp_path)
    service = WorkspaceService(workspace)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service, workspace.web_dir))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        status, payload = _request(base, "/api/project")
        assert status == 404 and payload["error"] == "not found"
        status, payload = _request(base, "/api/v1/workspace")
        assert status == 200 and payload["projects"][0]["project_id"] == "demo"
        status, settings = _request(base, "/api/v1/settings")
        assert status == 200 and settings["theme"] == "system"
        status, settings = _request(
            base,
            "/api/v1/settings",
            method="POST",
            payload={
                "theme": "dark",
                "density": "compact",
                "default_mode": "unassigned",
                "default_episode": "all",
                "poll_interval_ms": 5000,
                "update_sound": False,
                "show_unknown_count": False,
            },
        )
        assert status == 200 and settings["theme"] == "dark" and settings["poll_interval_ms"] == 5000
        status, payload = _request(
            base,
            "/api/v1/projects/demo/review",
            method="POST",
            payload={"action": "set_group", "group_id": "g", "state": "keep"},
        )
        assert status == 400 and "审核昵称" in payload["error"]
        status, _payload = _request(base, "/api/agent/v1/capabilities")
        assert status == 401
        _record, token = service.tokens.create("gateway-test", ["demo"], ["read"], 1)
        status, payload = _request(base, "/api/agent/v1/capabilities", token)
        assert status == 200 and payload["contract_version"] == "agent.v1"
        previous_url = os.environ.get("SCRIPT_ORGANIZER_URL")
        previous_token = os.environ.get("SCRIPT_ORGANIZER_AGENT_TOKEN")
        os.environ["SCRIPT_ORGANIZER_URL"] = base
        os.environ["SCRIPT_ORGANIZER_AGENT_TOKEN"] = token
        try:
            mcp_result = _tool_call(GatewayClient(), "list_projects", {})
        finally:
            if previous_url is None:
                os.environ.pop("SCRIPT_ORGANIZER_URL", None)
            else:
                os.environ["SCRIPT_ORGANIZER_URL"] = previous_url
            if previous_token is None:
                os.environ.pop("SCRIPT_ORGANIZER_AGENT_TOKEN", None)
            else:
                os.environ["SCRIPT_ORGANIZER_AGENT_TOKEN"] = previous_token
        mcp_projects = json.loads(mcp_result["content"][0]["text"])
        assert mcp_projects["projects"] == _request(base, "/api/agent/v1/projects", token)[1]["projects"]
        status, _payload = _request(base, "/api/agent/v1/projects/other/context", token)
        assert status == 403
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_media_head_preserves_range_headers_without_body(tmp_path):
    workspace = _workspace(tmp_path)
    config_path = _register_demo(workspace, tmp_path)
    service = WorkspaceService(workspace)
    index = json.loads((config_path.parent / "output" / "material_index.json").read_text(encoding="utf-8"))
    clip_id = index["groups"][0]["members"][0]["clip_id"]
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service, workspace.web_dir))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        get_request = urllib.request.Request(
            f"{base}/api/v1/projects/demo/media/{clip_id}",
            headers={"Range": "bytes=1-3"},
        )
        with urllib.request.urlopen(get_request, timeout=5) as response:
            assert response.status == 206
            assert response.headers["Content-Range"] == "bytes 1-3/5"
            assert response.read() == b"ide"

        status, headers, body = _head_request(
            base,
            f"/api/v1/projects/demo/media/{clip_id}",
            {"Range": "bytes=1-3"},
        )
        assert status == 206
        assert headers["Accept-Ranges"] == "bytes"
        assert headers["Content-Range"] == "bytes 1-3/5"
        assert headers["Content-Length"] == "3"
        assert body == b""
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_mcp_lists_only_gateway_mapped_tools(tmp_path):
    request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}) + "\n"
    result = subprocess.run(
        [sys.executable, "-m", "script_organizer.mcp_server"],
        input=request,
        capture_output=True,
        text=True,
        env={"PYTHONPATH": str(Path(__file__).parents[1] / "src")},
        check=True,
    )
    payload = json.loads(result.stdout)
    tools = {tool["name"] for tool in payload["result"]["tools"]}
    assert tools == {
        "capabilities",
        "list_projects",
        "project_context",
        "search",
        "get_evidence",
        "submit_task",
        "submit_proposal",
    }


def test_workspace_gateway_isolates_same_project_ids_and_pairing(tmp_path):
    left_root = tmp_path / "left"
    right_root = tmp_path / "right"
    left_root.mkdir()
    right_root.mkdir()
    left = _workspace(left_root)
    right = _workspace(right_root)
    _register_demo(left, left_root, "shared")
    _register_demo(right, right_root, "shared")
    left = left.with_workspace_id("ws_left")
    right = right.with_workspace_id("ws_right")
    left.config_path.write_text(
        left.config_path.read_text(encoding="utf-8").replace("[workspace]\n", '[workspace]\nid = "ws_left"\n'),
        encoding="utf-8",
    )
    right.config_path.write_text(
        right.config_path.read_text(encoding="utf-8").replace("[workspace]\n", '[workspace]\nid = "ws_right"\n'),
        encoding="utf-8",
    )
    left = WorkspaceConfig.from_file(left.config_path)
    right = WorkspaceConfig.from_file(right.config_path)
    gateway = WorkspaceGateway([left, right], pairing_code="123456")
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_gateway_handler(gateway, left.web_dir))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        status, payload = _request(base, "/api/v1/workspaces")
        assert status == 200
        assert {item["workspace_id"] for item in payload["workspaces"]} == {"ws_left", "ws_right"}

        status, payload = _request(base, "/api/v1/workspaces/ws_left/projects/shared")
        assert status == 200
        assert payload["project_id"] == "shared"

        status, payload = _request(base, "/api/v1/workspaces/unknown/projects/shared")
        assert status == 404
        assert "工作区" in payload["error"]

        status, payload = _request(
            base,
            "/api/v1/workspaces/ws_right/projects/shared/review",
            method="POST",
            payload={"action": "set_group", "group_id": "right-only", "state": "keep", "actor": "tester"},
        )
        assert status == 200
        right_review = json.loads((right.registry_path.parent / "shared" / "output" / "review.json").read_text(encoding="utf-8"))
        left_review_path = left.registry_path.parent / "shared" / "output" / "review.json"
        left_review = json.loads(left_review_path.read_text(encoding="utf-8")) if left_review_path.exists() else {"groups": {}}
        assert "right-only" in right_review["groups"]
        assert "right-only" not in left_review["groups"]

        status, _payload = _request(base, "/api/v1/workspaces/ws_left/projects/shared")
        assert status == 200
        assert _request(base, "/api/v1/pairing", method="POST", payload={"code": "wrong"})[0] == 401
        status, payload = _request(base, "/api/v1/pairing", method="POST", payload={"code": "123456"})
        assert status == 200 and payload["session"].startswith("mos_")

        left_service = gateway.select("ws_left")
        _record, token = left_service.tokens.create("gateway-agent", ["shared"], ["read"], 1)
        status, payload = _request(
            base,
            "/api/agent/v1/workspaces/ws_left/projects/shared/context",
            token,
        )
        assert status == 200 and payload["project"]["project_id"] == "shared"
        status, _payload = _request(
            base,
            "/api/agent/v1/workspaces/ws_right/projects/shared/context",
            token,
        )
        assert status == 401

        previous_url = os.environ.get("SCRIPT_ORGANIZER_URL")
        previous_token = os.environ.get("SCRIPT_ORGANIZER_AGENT_TOKEN")
        previous_workspace = os.environ.get("SCRIPT_ORGANIZER_WORKSPACE_ID")
        os.environ["SCRIPT_ORGANIZER_URL"] = base
        os.environ["SCRIPT_ORGANIZER_AGENT_TOKEN"] = token
        os.environ["SCRIPT_ORGANIZER_WORKSPACE_ID"] = "ws_left"
        try:
            mcp_result = _tool_call(GatewayClient(), "project_context", {"project_id": "shared"})
        finally:
            for key, value in {
                "SCRIPT_ORGANIZER_URL": previous_url,
                "SCRIPT_ORGANIZER_AGENT_TOKEN": previous_token,
                "SCRIPT_ORGANIZER_WORKSPACE_ID": previous_workspace,
            }.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        assert json.loads(mcp_result["content"][0]["text"])["project"]["project_id"] == "shared"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_gateway_pairing_restricts_non_local_clients():
    security = GatewaySecurity(require_pairing=True, pairing_code="code")
    assert security.public()["session_ttl_seconds"] == 12 * 60 * 60
    assert security.allow("192.168.1.10", "") is False
    session = security.exchange("code")
    assert security.allow("192.168.1.10", session) is True
    assert GatewaySecurity(require_pairing=False).allow("192.168.1.10", "") is True
