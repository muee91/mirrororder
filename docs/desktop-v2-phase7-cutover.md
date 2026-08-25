# MirrorOrder Desktop v2 Phase 7 Cutover

Branch: `feat/desktop-v2-tauri`

Phase 7 is a **retirement/cutover phase**, not a new business-feature phase. Desktop v2 becomes the primary desktop implementation only after the parity gates below are code-complete. The legacy SwiftUI application remains a frozen regression reference until the native release gates pass on real macOS and Windows machines.

GitHub Actions are not required for this cutover. Local and manual verification is valid evidence; the important requirement is that the listed checks actually run against the source and packaged applications before SwiftUI is removed.

## Authority boundaries remain frozen

- Python Core remains authority for workspace/project lifecycle, Review, Slate, Identity, Assistant, AI proposals, media identity/binding semantics, Team Web security/review semantics and FCPXML delivery semantics.
- Rust Timeline Core remains authority for local timeline edit state, deterministic edit commands, persistence and recovery.
- React/TypeScript remains the production UI and only talks to the existing Python Core through typed localhost contracts, plus narrow Tauri native commands.
- Team Web remains a lightweight reviewer/projection surface. Desktop may own its **process lifecycle and launch UX**, but not its review/business authority.
- SwiftUI is not allowed to receive new product features after Phase 7 RC.

## Feature-isolation rule

Phase 7 must not turn the project workbench into a feature dumping ground.

- Existing project tabs are parity/product surfaces, not generic plugin slots.
- Team Web Gateway is a top-level **团队协作** workspace because it has a separate process, port, network/security boundary and multi-workspace lifecycle.
- Heavy media processing, new NLE adapters, model-runtime infrastructure and experimental automation engines should start in an isolated module and, when the change is substantial, an isolated branch/worktree.
- An isolated capability is promoted into the primary production workspace only after its typed contract, ownership boundary, failure isolation and native smoke gate are explicit.
- A feature does not become a project tab merely because the Desktop can launch it.

The machine-readable form of this rule lives in `desktop-v2/phase7-parity.json` under `isolation_policy`.

## Desktop parity gates

The machine-readable source is `desktop-v2/phase7-parity.json`.

### Project lifecycle

Desktop v2 now supports:

1. native script / FCPXML / media-directory selection,
2. Python `WorkspaceRegistry.preflight_create`,
3. Python `WorkspaceRegistry.create`,
4. optional `prepare_project` task submission,
5. project deletion using the existing echoed `project_id` safeguard,
6. immediate workspace refresh and project selection after mutation.

Desktop does not duplicate project validation or configuration generation.

### Material / Script

Phase 2 workbench remains the authority-preserving Desktop implementation for rough episode placement, exact script placement, candidates/evidence, virtualization and angle-level media facts.

### Slate

Desktop uses the existing Script Supervisor parser and revision-safe writes. Rough handwritten notes remain first-class input.

### Identity

Desktop exposes local identity evidence, human label/role confirmation and role suggestions. Embeddings remain device-local and are not returned to React.

### Assistant

Desktop provides the full project assistant surface plus device-local model connection settings. Assistant actions remain evidence/proposal based and do not bypass Review or Editorial Decision authority.

### Settings / Status

`desktop_status.v1` exposes only diagnostic facts:

- Python executable/version,
- ffmpeg/ffprobe/llama-server availability,
- required/optional Python modules,
- workspace writability,
- multicam engine availability/origin,
- device media state location,
- identity runtime readiness.

The Desktop page combines those facts with Tauri platform capabilities, existing Python frontend settings, local intelligence runtime controls, browser-user/access audit, a read-only view of the existing Python TaskManager, and Rust Timeline persistence status. It does not become a second business configuration store or a new task scheduler.

### Media binding

`media_binding.v1` delegates to the existing `DeviceMediaStore`:

- read roots and resolved/missing inventory,
- append roots and scan,
- replace roots and rescan,
- content-media-ID matching first,
- unique-filename fallback only for provisional legacy IDs,
- device-local state only; no shared workspace or Review mutation.

### Team Web Gateway

The legacy SwiftUI app used a separate Python Workspace Gateway for team review. Desktop v2 now preserves that boundary in an isolated top-level workspace:

- Production Host remains a single-workspace, loopback Host on the production path (default 8765).
- Team Web Gateway uses its own Tauri process manager and default port 8766.
- Gateway startup delegates to the existing `python -m script_organizer.cli gateway` implementation.
- Multi-workspace scope, local-only vs LAN access, pairing vs trusted-LAN security and pairing-code semantics remain Python Gateway semantics.
- Desktop generates only workspace/project query targeting; it does not invent a new Team Web route.
- LAN mode does not fall back to a localhost "share" URL when a real LAN address cannot be resolved.
- Opening the Team Web URL uses a narrow native `http/https` URL adapter.
- Stopping Team Web Gateway does not stop the Production Host.
- Production Host and Team Gateway do not report launch success until their expected loopback TCP port is actually listening; early-exit/timeout children are rolled back.

This gate remains **native-smoke-required** on both macOS and Windows because LAN interface discovery, firewall behavior and packaged-process startup cannot be proven by code inspection alone.

### macOS FCP integration

Desktop delivery reuses the existing Python exporter and the narrow macOS Tauri Final Cut adapter. The exporter still protects synchronized multicam structure; `selection_manifest.json` carries delivery decisions until a structure-specific safe FCPXML writer exists.

## Packaged runtime blocker

A source checkout being runnable does not prove a distributable Desktop app can launch its Python Core. The packaged runtime is therefore an explicit isolated release blocker on:

`feat/desktop-v2-runtime-packaging`

That workstream must produce a self-contained application runtime containing:

- MirrorOrder Python Core;
- the first-party multicam engine;
- Python 3.11+ with `numpy`, `pandas`, and `scipy`;
- `ffmpeg` and `ffprobe`.

The base installer does **not** need to bundle optional model runtimes or model weights. `llama-server`, ASR backends, CV/identity dependencies and model weights remain optional/on-demand unless a later product decision gives them a separate release contract.

The runtime workstream is fail-closed: a packaged build must not silently fall back to the user's global Python or FFmpeg toolchain. It also validates that the staged runtime remains executable after being copied into the Tauri resources layout.

This blocker is represented by both `packaged_python_runtime` and `packaged_media_toolchain` in `phase7-parity.json`.

## SwiftUI retirement policy

`macos-app/` is now a **legacy frozen regression reference**.

Do not:

- add new product features to SwiftUI,
- make SwiftUI the source of a new business rule,
- delete SwiftUI only because Desktop v2 is code-complete.

Physical deletion is allowed only after all native release gates below pass.

## Required release gates before deletion

### Cross-platform local gate

Run the machine-readable cutover guard first:

```bash
cd desktop-v2
npm run check:phase7
```

Then run the source tests locally:

```bash
npm install
npm run typecheck
npm test
npm run build

cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml

cd ..
pytest
```

These commands are intentionally local; no GitHub Actions workflow is required.

### Packaged runtime gate

On the isolated packaging branch, using the actual platform/architecture release payloads:

```bash
cd desktop-v2
MIRRORORDER_PORTABLE_PYTHON_ROOT=<portable-python> \
MIRRORORDER_MEDIA_TOOLS_ROOT=<ffmpeg-tool-root> \
npm run stage:runtime
```

The staging command must pass before a release package is considered meaningful. It verifies hard Python modules, FFmpeg/FFprobe, first-party multicam files, self-contained symlinks and post-copy relocation.

### macOS native gate

- `cargo tauri build` with the actual staged macOS runtime
- launch the packaged app without the developer checkout or dependence on Homebrew/system Python/FFmpeg
- Python Production Host launch from the packaged app
- verify packaged diagnostics report Python/modules/FFmpeg/multicam ready
- open/create/delete a real project
- bind and replay real media
- run a real multicam task
- Timeline persistence/recovery smoke
- Finder reveal
- delivery export
- Final Cut Pro open/import smoke
- Team Web Gateway launch/stop without affecting Production Host
- Team Web LAN link reachable from a second device; pairing and trusted-LAN modes both checked
- codesign/notarization/bundle/update smoke, including nested portable runtime executables/libraries

### Windows native gate

- `cargo tauri build` with the actual staged Windows runtime
- install/launch without the developer checkout or global Python/FFmpeg
- Python Production Host launch from the packaged app
- verify packaged diagnostics report Python/modules/FFmpeg/multicam ready
- open/create/delete a real project
- bind and replay real media through WebView2/proxy path
- run a real multicam task
- Timeline persistence/recovery smoke
- Explorer reveal
- Team Web Gateway launch/stop without affecting Production Host
- Team Web LAN link reachable from a second device; pairing and trusted-LAN modes both checked
- installer/update/uninstall smoke

Resolve/Premiere integration stays an extension point and is not a Phase 7 retirement blocker.

## Current cutover state

- Desktop v2: **primary candidate / Phase 7 RC**
- SwiftUI: **legacy frozen reference**
- SwiftUI physical deletion: **blocked by local/native release gates**
- packaged Python/media runtime: **isolated blocker; not yet proven by target package smoke**
- Team Web business/review boundary: unchanged; Desktop v2 owns only an isolated launch/lifecycle workspace
- Python Core authority: unchanged
