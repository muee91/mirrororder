from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


SERVER_NAME = "script-material-platform"
SERVER_VERSION = "1.1.0"
AGENT_TASK_TYPES = [
    "prepare_project",
    "multicam_sync",
    "incremental_analyze",
    "auto_resolve",
    "transcribe",
    "evidence_extract",
]


class GatewayClient:
    def __init__(self) -> None:
        self.base_url = os.environ.get("SCRIPT_ORGANIZER_URL", "http://127.0.0.1:8765").rstrip("/")
        self.token = os.environ.get("SCRIPT_ORGANIZER_AGENT_TOKEN", "")

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> object:
        if not self.token:
            raise RuntimeError("缺少 SCRIPT_ORGANIZER_AGENT_TOKEN")
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read().decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                detail = {}
            raise RuntimeError(str(detail.get("error") or f"Gateway HTTP {error.code}")) from error
        except (urllib.error.URLError, UnicodeDecodeError, ValueError) as error:
            raise RuntimeError(f"无法连接 Agent Gateway: {error}") from error


TOOLS = [
    {
        "name": "capabilities",
        "description": "读取 Agent Gateway 能力、允许动作、禁止动作和可访问项目。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_projects",
        "description": "列出当前令牌可访问的项目。",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "project_context",
        "description": "读取项目约束、版本、数据权威和当前状态；任何分析或提案前必须调用。",
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": {"type": "string"}},
            "required": ["project_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search",
        "description": "搜索项目内素材文件名、路径、剧本或现有 ASR 证据。",
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": {"type": "string"}, "query": {"type": "string"}},
            "required": ["project_id", "query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_evidence",
        "description": "读取一个逻辑 Take 的有效片内范围、候选、现有审核和可复核证据。",
        "inputSchema": {
            "type": "object",
            "properties": {"project_id": {"type": "string"}, "group_id": {"type": "string"}},
            "required": ["project_id", "group_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "submit_task",
        "description": "提交受限 Host 任务。可执行同步、ASR、分析和自动救援；只写派生产物，不直接写人工 review.json。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "type": {"enum": AGENT_TASK_TYPES},
                "targets": {"type": "object"},
                "idempotency_key": {"type": "string"},
            },
            "required": ["project_id", "type"],
            "additionalProperties": False,
        },
    },
    {
        "name": "submit_proposal",
        "description": "提交待人工确认的归集提案。不能 Reject，不能直接写 review.json。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "group_id": {"type": "string"},
                "episode_ids": {"type": "array", "items": {"type": "integer"}},
                "script_segment_ids": {"type": "array", "items": {"type": "string"}},
                "evidence": {"type": "array", "items": {"type": "object"}},
                "note": {"type": "string"},
                "base_analysis_revision": {"type": "string"},
                "base_review_revision": {"type": "integer"},
            },
            "required": [
                "project_id",
                "group_id",
                "episode_ids",
                "script_segment_ids",
                "evidence",
                "base_analysis_revision",
                "base_review_revision",
            ],
            "additionalProperties": False,
        },
    },
]


def _result(payload: object) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}]}


def _tool_call(client: GatewayClient, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    project_id = urllib.parse.quote(str(arguments.get("project_id", "")), safe="")
    if name == "capabilities":
        return _result(client.request("GET", "/api/agent/v1/capabilities"))
    if name == "list_projects":
        return _result(client.request("GET", "/api/agent/v1/projects"))
    if name == "project_context":
        return _result(client.request("GET", f"/api/agent/v1/projects/{project_id}/context"))
    if name == "search":
        query = urllib.parse.urlencode({"q": str(arguments.get("query", ""))})
        return _result(client.request("GET", f"/api/agent/v1/projects/{project_id}/search?{query}"))
    if name == "get_evidence":
        group_id = urllib.parse.quote(str(arguments.get("group_id", "")), safe="")
        return _result(client.request("GET", f"/api/agent/v1/projects/{project_id}/evidence/{group_id}"))
    if name == "submit_task":
        payload = {
            "type": arguments.get("type"),
            "targets": arguments.get("targets", {}),
            "idempotency_key": arguments.get("idempotency_key", ""),
        }
        return _result(client.request("POST", f"/api/agent/v1/projects/{project_id}/tasks", payload))
    if name == "submit_proposal":
        payload = {key: value for key, value in arguments.items() if key != "project_id"}
        return _result(client.request("POST", f"/api/agent/v1/projects/{project_id}/proposals", payload))
    raise RuntimeError("未知工具")


def _response(request_id: object, result: object | None = None, error: str = "") -> dict[str, Any]:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error:
        payload["error"] = {"code": -32000, "message": error}
    else:
        payload["result"] = result
    return payload


def main() -> int:
    client = GatewayClient()
    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params", {})
            if method == "initialize":
                response = _response(
                    request_id,
                    {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                    },
                )
            elif method == "notifications/initialized":
                continue
            elif method == "tools/list":
                response = _response(request_id, {"tools": TOOLS})
            elif method == "tools/call":
                response = _response(request_id, _tool_call(client, str(params.get("name", "")), params.get("arguments", {})))
            else:
                response = _response(request_id, error="不支持的 MCP 方法")
        except Exception as error:
            response = _response(locals().get("request_id"), error=str(error))
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
