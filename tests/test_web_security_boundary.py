from __future__ import annotations

import inspect
import json
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer import cli
from script_organizer.web_server import (
    ApiError,
    GatewaySecurity,
    _is_loopback_source,
    make_gateway_handler,
    make_handler,
    serve,
    serve_gateway,
)


def _write_workspace(tmp_path: Path) -> Path:
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (tmp_path / "projects").mkdir()
    (tmp_path / "projects" / "registry.json").write_text('{"version":1,"projects":[]}', encoding="utf-8")
    config_path = tmp_path / "workspace.toml"
    config_path.write_text(
        "[workspace]\nname='security boundary test'\n"
        "registry='./projects/registry.json'\nweb_directory='./web'\n",
        encoding="utf-8",
    )
    return config_path


def _handler_with_source(handler_cls: type, client_host: str):
    """只造一个能调用权限判定的 handler 实例，不启动真服务器。

    被测的判定函数只读 ``client_address``，因此不需要 socket 与 HTTP 生命周期。
    """
    handler = object.__new__(handler_cls)
    handler.client_address = (client_host, 51234)
    return handler


def test_serve_entrypoints_default_to_loopback():
    assert inspect.signature(serve).parameters["host"].default == "127.0.0.1"
    assert inspect.signature(serve_gateway).parameters["host"].default == "127.0.0.1"


def test_cli_defaults_to_loopback_and_keeps_explicit_lan_binding(tmp_path, monkeypatch):
    config_path = _write_workspace(tmp_path)
    launched: list[tuple[str, str, int]] = []
    monkeypatch.setattr(cli, "install_production_runtime", lambda: None)
    monkeypatch.setattr(cli, "LocalVisionRuntime", SimpleNamespace(stop=lambda: None))
    monkeypatch.setattr(cli, "serve", lambda workspace, host, port: launched.append(("serve", host, port)))
    monkeypatch.setattr(
        cli,
        "serve_gateway",
        lambda workspaces, host, port, **kwargs: launched.append(("gateway", host, port)),
    )

    assert cli.main(["serve", str(config_path)]) == 0
    assert cli.main(["gateway", str(config_path)]) == 0
    assert launched == [("serve", "127.0.0.1", 8765), ("gateway", "127.0.0.1", 8766)]

    assert cli.main(["serve", str(config_path), "--host", "0.0.0.0", "--port", "9123"]) == 0
    assert cli.main(["gateway", str(config_path), "--host", "0.0.0.0", "--port", "9124"]) == 0
    assert launched[-2:] == [("serve", "0.0.0.0", 9123), ("gateway", "0.0.0.0", 9124)]

    assert cli.main(["serve", str(config_path), "--local-only", "--port", "9125"]) == 0
    assert launched[-1] == ("serve", "127.0.0.1", 9125)


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("127.0.0.1", True),
        ("127.0.0.9", True),
        ("::1", True),
        ("[::1]", True),
        ("::ffff:127.0.0.1", True),
        ("192.168.1.20", False),
        ("10.0.0.5", False),
        ("0.0.0.0", False),
        ("", False),
        ("localhost", False),
    ],
)
def test_loopback_source_detection(host, expected):
    assert _is_loopback_source(host) is expected


def test_review_write_is_denied_from_lan_source(tmp_path):
    handler_cls = make_handler(object(), tmp_path)
    with pytest.raises(ApiError) as error:
        _handler_with_source(handler_cls, "192.168.1.50")._require_review_access()
    assert error.value.status == HTTPStatus.FORBIDDEN
    assert "Gateway" in str(error.value)


def test_review_write_stays_allowed_for_loopback_source(tmp_path):
    handler_cls = make_handler(object(), tmp_path)
    for host in ("127.0.0.1", "::1"):
        _handler_with_source(handler_cls, host)._require_review_access()


def test_local_only_guard_also_denies_lan_source(tmp_path):
    handler_cls = make_handler(object(), tmp_path)
    with pytest.raises(ApiError) as error:
        _handler_with_source(handler_cls, "10.1.2.3")._local_only()
    assert error.value.status == HTTPStatus.FORBIDDEN


def test_gateway_review_access_keeps_reviewer_role_check_for_lan_client(tmp_path):
    gateway = SimpleNamespace(security=GatewaySecurity(pairing_code="123456"))
    handler_cls = make_gateway_handler(gateway, tmp_path)
    handler = _handler_with_source(handler_cls, "192.168.1.40")
    handler._browser_user = lambda: {"nickname": "剪辑甲", "role": "manager", "status": "active"}
    handler._require_review_access()

    handler._browser_user = lambda: {"nickname": "访客", "role": "viewer", "status": "active"}
    with pytest.raises(ApiError) as error:
        handler._require_review_access()
    assert error.value.status == HTTPStatus.FORBIDDEN


def test_pairing_code_has_64_bits_of_secret():
    codes = {GatewaySecurity(pairing_code=None).pairing_code for _ in range(8)}
    # token_urlsafe(8)：8 字节熵 → 11 个 URL-safe 字符（旧值 6 字节只有 8 字符）。
    assert all(len(code) == 11 for code in codes)
    assert len(codes) == 8


def test_pairing_failures_are_throttled_per_source():
    security = GatewaySecurity(pairing_code="code", pairing_cooldown_seconds=0.05)
    for _ in range(5):
        with pytest.raises(ApiError) as error:
            security.exchange("wrong", "192.168.1.60")
        assert error.value.status == HTTPStatus.UNAUTHORIZED

    with pytest.raises(ApiError) as error:
        security.exchange("wrong", "192.168.1.60")
    assert error.value.status == HTTPStatus.TOO_MANY_REQUESTS
    # 冷却期内正确的配对码同样被拒，限速不因猜测正确与否而松动。
    with pytest.raises(ApiError) as error:
        security.exchange("code", "192.168.1.60")
    assert error.value.status == HTTPStatus.TOO_MANY_REQUESTS

    # 另一来源不受影响。
    assert security.exchange("code", "192.168.1.61").startswith("mos_")

    time.sleep(0.12)
    assert security.exchange("code", "192.168.1.60").startswith("mos_")


def test_successful_pairing_resets_failure_counter():
    security = GatewaySecurity(pairing_code="code", pairing_cooldown_seconds=0.05)
    for _ in range(4):
        with pytest.raises(ApiError):
            security.exchange("wrong", "host-a")
    assert security.exchange("code", "host-a").startswith("mos_")

    for _ in range(4):
        with pytest.raises(ApiError) as error:
            security.exchange("wrong", "host-a")
        assert error.value.status == HTTPStatus.UNAUTHORIZED
    assert security.exchange("code", "host-a").startswith("mos_")


def _post_pairing(base: str, code: str) -> tuple[int, dict]:
    request = urllib.request.Request(
        base + "/api/v1/pairing",
        data=json.dumps({"code": code}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def test_pairing_endpoint_returns_429_after_repeated_failures(tmp_path):
    security = GatewaySecurity(pairing_code="123456")
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_gateway_handler(SimpleNamespace(security=security), tmp_path),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        for _ in range(5):
            status, payload = _post_pairing(base, "wrong")
            assert status == HTTPStatus.UNAUTHORIZED
            assert payload["error"] == "局域网配对码无效"
        status, payload = _post_pairing(base, "123456")
        assert status == HTTPStatus.TOO_MANY_REQUESTS
        assert "秒后重试" in payload["error"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_pairing_endpoint_passes_client_address_to_throttle(tmp_path):
    security = GatewaySecurity(pairing_code="123456")
    calls: list[tuple[str, str]] = []
    original = security.exchange

    def record(code: str, source: str = "") -> str:
        calls.append((code, source))
        return original(code, source)

    security.exchange = record  # type: ignore[method-assign]
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_gateway_handler(SimpleNamespace(security=security), tmp_path),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:{server.server_address[1]}/api/v1/pairing",
            data=json.dumps({"code": "123456"}).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                assert response.status == 200
                assert json.loads(response.read().decode("utf-8")) == {"paired": True}
        except urllib.error.HTTPError as error:  # pragma: no cover - 失败时给出可读原因
            raise AssertionError(f"配对应成功，实际 {error.code}: {error.read()!r}") from error
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert calls == [("123456", "127.0.0.1")]
