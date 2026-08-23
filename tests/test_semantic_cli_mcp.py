from __future__ import annotations

import json
from pathlib import Path

from script_organizer import mcp_server


class FakeGatewayClient:
    def __init__(self) -> None:
        self.calls = []

    def scoped_path(self, path: str) -> str:
        return path

    def request(self, method: str, path: str, payload=None):
        self.calls.append((method, path, payload))
        return {"contract": "semantic_search.v1", "results": []}


def test_mcp_exposes_read_only_semantic_search() -> None:
    tool = next(row for row in mcp_server.TOOLS if row["name"] == "semantic_search")
    assert "只读" in tool["description"]
    assert set(tool["inputSchema"]["properties"]["sources"]["items"]["enum"]) == {
        "visual",
        "speech",
        "slate",
    }

    client = FakeGatewayClient()
    payload = mcp_server._tool_call(
        client,
        "semantic_search",
        {
            "project_id": "demo",
            "query": "门口回头的反应镜头",
            "limit": 9,
            "sources": ["visual", "slate"],
        },
    )
    assert client.calls == [
        (
            "GET",
            "/api/agent/v1/projects/demo/semantic-search?q=%E9%97%A8%E5%8F%A3%E5%9B%9E%E5%A4%B4%E7%9A%84%E5%8F%8D%E5%BA%94%E9%95%9C%E5%A4%B4&limit=9&sources=visual%2Cslate",
            None,
        )
    ]
    body = json.loads(payload["content"][0]["text"])
    assert body["contract"] == "semantic_search.v1"


def test_cli_declares_semantic_search_without_shell_agent_surface() -> None:
    root = Path(__file__).resolve().parents[1]
    cli = (root / "src" / "script_organizer" / "cli.py").read_text(encoding="utf-8")
    mcp = (root / "src" / "script_organizer" / "mcp_server.py").read_text(encoding="utf-8")
    pyproject = (root / "pyproject.toml").read_text(encoding="utf-8")

    assert '"semantic-search"' in cli
    assert 'SemanticSearcher(' in cli
    assert 'choices=("visual", "speech", "slate")' in cli
    assert '"semantic_search"' in mcp
    assert '/semantic-search?' in mcp
    assert 'script-organizer-mcp = "script_organizer.mcp_server:main"' in pyproject

    # Agents receive explicit service verbs, not arbitrary shell execution.
    tool_names = {row["name"] for row in mcp_server.TOOLS}
    assert "shell" not in tool_names
    assert "exec" not in tool_names
    assert "run_cli" not in tool_names
