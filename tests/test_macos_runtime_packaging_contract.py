from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_tauri_build_stages_packaged_runtime_before_bundle() -> None:
    config = json.loads(read("desktop/src-tauri/tauri.conf.json"))
    assert config["build"]["beforeBuildCommand"] == "npm run stage:runtime && npm run build"
    resources = config["bundle"]["resources"]
    assert resources["resources/mirrororder-core/"] == "mirrororder-core/"
    assert resources["resources/mirrororder-python/"] == "mirrororder-python/"
    assert resources["resources/mirrororder-tools/"] == "mirrororder-tools/"
    assert resources["resources/mirrororder-runtime/"] == "mirrororder-runtime/"


def test_packaged_runtime_is_fail_closed_and_used_by_host_and_gateway() -> None:
    runtime = read("desktop/src-tauri/src/runtime.rs")
    host = read("desktop/src-tauri/src/host.rs")
    gateway = read("desktop/src-tauri/src/gateway.rs")
    main = read("desktop/src-tauri/src/main.rs")

    assert 'const PACKAGED_RUNTIME_CONTRACT: &str = "mirrororder_packaged_runtime.v1"' in runtime
    assert "打包态不会静默依赖用户机器上的 python3" in runtime
    assert "ffmpeg/ffprobe" in runtime
    assert "resolve_python_runtime(&app)?" in host
    assert "resolve_python_runtime(&app)?" in gateway
    assert 'env("MIRRORORDER_PACKAGED_RUNTIME", "1")' in host
    assert 'env("MIRRORORDER_PACKAGED_RUNTIME", "1")' in gateway
    assert "mod runtime;" in main


def test_stager_requires_relocatable_python_and_media_tools() -> None:
    stager = read("desktop/scripts/stage-runtime.mjs")
    verifier = read("desktop/scripts/verify-macos-bundle.mjs")
    tool_policy = read("desktop/scripts/runtime-tools.mjs")

    assert "MIRRORORDER_PORTABLE_PYTHON_ROOT" in stager
    assert "MIRRORORDER_MEDIA_TOOLS_ROOT" in stager
    assert "assertSelfContainedSymlinks" in stager
    assert "staged Python relocation probe" in stager
    assert "parseToolVersionOutput" in stager
    assert "./runtime-tools.mjs" in stager
    assert "--enable-nonfree" in tool_policy
    assert "license_classification" in stager
    assert "sha256" in tool_policy
    assert 'contract: "mirrororder_packaged_runtime.v1"' in stager
    assert "requirements-semantic.txt" in stager
    assert "probeSemanticRuntime" in stager
    assert "MIRRORORDER_REQUIRE_SEMANTIC_RUNTIME" in stager
    assert "'sentence_transformers'" in stager
    assert "'torchvision'" in stager
    assert "otool" in verifier
    assert "bundledMachOFiles" in verifier
    assert "nested Mach-O gate" in verifier
    assert "MIRRORORDER_REQUIRE_SEMANTIC_RUNTIME" in verifier
    assert "assertManifestToolMatches" in verifier
    assert "license classification" in verifier
    assert "version_output" in tool_policy
    assert "/opt/homebrew" not in verifier  # generic external-dylib policy, not path-specific allowlisting
    assert "MIRRORORDER_REQUIRE_CODESIGN" in verifier
