from __future__ import annotations

import http.client
import json
import threading
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

from script_organizer import desktop_runtime, media_inventory_task_runtime, tasks, web_server
from script_organizer.media_identity import DeviceMediaStore, provisional_media_id


@contextmanager
def _binding_server(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    media = tmp_path / "media"
    media.mkdir()
    files = [media / "A001.mov", media / "B001.mov"]
    for file in files:
        file.write_bytes(b"synthetic media")
    index = {"clips": [{"clip_id": file.stem, "media_path": str(tmp_path / "old" / file.name)} for file in files]}
    device = DeviceMediaStore()
    device.scan("ws_demo", "demo", index, [str(media)])
    project = SimpleNamespace(project_id="demo", index=index, reload=lambda: None)
    service = SimpleNamespace(workspace=SimpleNamespace(workspace_id="ws_demo"), project=lambda _id: project)

    # Compose the actual scan and confirmation adapters without starting models
    # or changing process-global installers for the rest of the test suite.
    monkeypatch.setattr(web_server, "make_handler", web_server.make_handler)
    monkeypatch.setattr(desktop_runtime, "_INSTALLED", False)
    monkeypatch.setattr(desktop_runtime, "initialize_device_tasks", lambda: SimpleNamespace(list=lambda: []))
    monkeypatch.setattr(media_inventory_task_runtime, "_INSTALLED", False)
    for name in ("scan", "probe_roots", "remove_project"):
        monkeypatch.setattr(DeviceMediaStore, name, getattr(DeviceMediaStore, name))
    monkeypatch.setattr(tasks.TaskManager, "_run", tasks.TaskManager._run)
    monkeypatch.setattr(tasks, "TASK_TYPES", set(tasks.TASK_TYPES))
    desktop_runtime.install_desktop_runtime()
    media_inventory_task_runtime.install_media_inventory_task_runtime()
    handler = web_server.make_handler(service, tmp_path)
    handler.protocol_version = "HTTP/1.1"
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = http.client.HTTPConnection(*server.server_address, timeout=1)
    try:
        yield connection, device, files
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _post(connection, payload):
    connection.request("POST", "/api/v1/projects/demo/media-binding", json.dumps(payload), {"Content-Type": "application/json"})
    response = connection.getresponse()
    return response.status, json.loads(response.read())


def test_confirmation_survives_scan_adapter_and_resets_body_on_keepalive(tmp_path, monkeypatch):
    with _binding_server(tmp_path, monkeypatch) as (connection, device, files):
        socket = None
        for count, file in enumerate(files, 1):
            status, payload = _post(connection, {
                "action": "confirm_provisional",
                "media_id": provisional_media_id(file.name),
                "candidate_path": str(file),
            })
            assert status == 200
            assert payload["summary"]["resolved"] == count
            if socket is not None:
                assert connection.sock is socket
            socket = connection.sock
        snapshot = device.project_snapshot("ws_demo", "demo")
        assert len(snapshot["confirmed_provisional"]) == 2


def test_invalid_action_does_not_poison_next_keepalive_confirmation(tmp_path, monkeypatch):
    with _binding_server(tmp_path, monkeypatch) as (connection, _device, files):
        status, _payload = _post(connection, {"action": "invalid"})
        assert status == 400
        file = files[0]
        status, payload = _post(connection, {
            "action": "confirm_provisional",
            "media_id": provisional_media_id(file.name),
            "candidate_path": str(file),
        })
        assert status == 200
        assert payload["summary"]["resolved"] == 1
