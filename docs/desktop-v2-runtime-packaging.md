# Desktop v2 Runtime Packaging Workstream

Branch: `feat/desktop-v2-runtime-packaging`

This branch exists because packaged Python/media-runtime delivery is a release blocker, but it is not a production-workbench feature. Keep it isolated from `feat/desktop-v2-tauri` until native package smoke tests pass.

## Scope

A distributable MirrorOrder Desktop build must not depend on the developer checkout, the user's global Python installation, or the user's global FFmpeg installation.

The packaged hard runtime is intentionally limited to:

- MirrorOrder Python Core: `src/script_organizer`
- first-party multicam engine: `vendor/multicam-audio-sync`
- Python 3.11 or newer
- Python modules required by the existing production readiness contract: `numpy`, `pandas`, `scipy`
- `ffmpeg`
- `ffprobe`

The following remain optional/on-demand and are deliberately not promoted into the base installer by this workstream:

- `llama-server`
- `faster_whisper`
- `mlx_whisper`
- `cv2`
- `sherpa_onnx`
- local model weights

This preserves the existing product boundary: heavy model runtimes stay optional instead of silently inflating every Desktop installation.

## Resource layout

`stage:runtime` prepares these Tauri resources:

```text
src-tauri/resources/
├── mirrororder-core/
│   ├── src/script_organizer/
│   ├── vendor/multicam-audio-sync/
│   └── pyproject.toml
├── mirrororder-python/
├── mirrororder-tools/
│   └── bin/
│       ├── ffmpeg[.exe]
│       └── ffprobe[.exe]
└── mirrororder-runtime-manifest.json
```

`tauri.conf.json` maps those staged paths into the application resources directory.

## Staging inputs

The build machine must explicitly provide:

```text
MIRRORORDER_PORTABLE_PYTHON_ROOT
MIRRORORDER_MEDIA_TOOLS_ROOT
```

No downloader is hidden inside the Tauri build. Supply platform/architecture-specific runtime payloads through the release process, then run:

```bash
cd desktop-v2
npm run stage:runtime
```

`cargo tauri build` invokes staging automatically through `beforeBuildCommand` on this branch.

## Staging gates

The staging script fails before Tauri packaging unless all of the following hold:

1. portable Python is found inside `MIRRORORDER_PORTABLE_PYTHON_ROOT`;
2. Python reports version 3.11 or newer;
3. an isolated (`python -I`) probe imports `numpy`, `pandas`, and `scipy`;
4. `sys.executable` and `sys.prefix` remain inside the supplied Python root;
5. the MirrorOrder Core imports with only the supplied portable interpreter plus the repository source path;
6. `ffmpeg` and `ffprobe` exist under the supplied media-tools root and execute successfully;
7. the first-party multicam engine contains every script/schema required by `multicam_sync_engine.py`;
8. neither supplied runtime contains a broken symlink or a symlink resolving outside its own root;
9. after copying into `src-tauri/resources`, the staged Python is executed again and must still import the hard dependencies;
10. the staged MirrorOrder Core is imported again using the staged Python and staged multicam path;
11. staged `ffmpeg` and `ffprobe` are executed again.

The relocation probe is important: a runtime that only works at its original build-machine path is rejected even if its initial dependency probe passed.

## Runtime resolution

`src-tauri/src/runtime.rs` resolves Python in this order:

1. explicit developer override (`MIRRORORDER_CORE_ROOT`, optional `MIRRORORDER_PYTHON`);
2. packaged Tauri resources;
3. development checkout relative to `CARGO_MANIFEST_DIR`.

Packaged mode is fail-closed:

- Core without `mirrororder-runtime-manifest.json` is rejected;
- Core without packaged Python is rejected unless the operator explicitly sets `MIRRORORDER_PYTHON`;
- missing packaged `ffmpeg`/`ffprobe` is rejected;
- there is no implicit packaged fallback to `python3` or the system FFmpeg toolchain.

Production Host and Team Gateway both use this resolver. They also wait for the expected loopback TCP port before reporting a successful launch and kill an early-exit/timeout child.

## Device-local state

In packaged mode the Tauri process resolves its platform app-data directory and passes it to Python as both:

```text
MIRRORORDER_DATA_DIR
MIRRORORDER_DEVICE_STATE_DIR
```

This keeps runtime settings, model connection metadata/secrets, media bindings, and workspace SQLite state in the platform-appropriate application data location rather than relying on macOS-specific HOME paths.

The shared workspace remains separate and authoritative for shared project facts; these directories contain device-local state only.

## What this branch does not prove

Code/staging gates are not a substitute for packaged native verification. Do not merge this workstream as “release ready” and do not remove `macos-app/` until real native gates pass.

Required native verification still includes:

### macOS

- build a signed `.app`/installer with platform-appropriate portable Python and FFmpeg payloads;
- launch the packaged app with no developer checkout and no dependence on Homebrew/system Python;
- launch Production Host and query diagnostics;
- launch Team Gateway and complete LAN/pairing smoke;
- bind and replay real media;
- run a real multicam task;
- exercise Timeline persistence/recovery;
- export and open/import the FCPXML path in Final Cut Pro;
- codesign/notarization/update smoke, including nested runtime executables/libraries.

### Windows

- build the installer with Windows-native portable Python and FFmpeg payloads;
- install and launch on a machine without the developer checkout/global Python/global FFmpeg;
- launch Production Host and query diagnostics;
- launch Team Gateway and complete LAN/pairing smoke;
- bind and replay real media through WebView2/proxy path;
- run a real multicam task;
- exercise Timeline persistence/recovery;
- installer/update/uninstall smoke.

## Merge rule

This branch may be promoted only when:

- `npm run check:phase7` passes locally;
- `npm run stage:runtime` passes using the actual release payload for each target;
- TypeScript/Vitest/Python/Rust local tests pass;
- packaged macOS and Windows runtime smoke tests above are recorded as passing.

GitHub Actions are not required to satisfy this policy. Local/manual evidence is acceptable; the requirement is that the checks actually run on the target packages.
