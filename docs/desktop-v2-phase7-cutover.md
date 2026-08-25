# MirrorOrder Desktop v2 Phase 7 Cutover

`main` now uses Desktop v2 as the only Desktop client.

The previous SwiftUI `macos-app/` implementation was removed by explicit owner decision. This was a product cutover decision, **not** evidence that every native release gate has already passed.

GitHub Actions are not required for this cutover. Local and manual verification is valid evidence as long as the checks actually run against the source and packaged applications.

## Frozen authority boundaries

- Python Core remains authority for workspace/project lifecycle, Review, Slate, Identity, Assistant, AI proposals, media identity/binding semantics, Team Web security/review semantics and FCPXML delivery semantics.
- Rust Timeline Core remains authority for local timeline edit state, deterministic edit commands, persistence and recovery.
- React/TypeScript remains the production UI and does not become a second business or timeline source of truth.
- Team Web remains a lightweight reviewer/projection surface. Desktop owns only its isolated launch/lifecycle UX.
- AI still follows `evidence → proposal → human confirmation → authority`.

## Cutover state

```text
Desktop v2  → sole desktop implementation on main
SwiftUI     → removed
Python Core → unchanged business authority
Team Web    → unchanged review/projection boundary
```

`desktop-v2/phase7-parity.json` is the machine-readable source for code parity and remaining release gates.

## Feature-isolation rule

The Production workbench is not a generic feature dumping ground.

- Existing project tabs are product/parity surfaces.
- Team Web Gateway remains a separate top-level workspace because it owns a separate process/network/security boundary.
- Heavy media processing, runtime packaging, new NLE adapters, model-runtime infrastructure and experimental automation should begin in isolated modules and, for substantial work, isolated branches/worktrees.
- Promotion requires an explicit typed contract, ownership boundary, failure isolation and native smoke gate.

Runtime packaging remains isolated on:

```text
feat/desktop-v2-runtime-packaging
```

It is still a release blocker for distributable Desktop builds, but it does not restore or depend on the removed SwiftUI client.

## Desktop parity gates

Desktop v2 contains the production surfaces for:

- project lifecycle
- material/script placement
- slate/script-supervisor writes
- identity confirmation
- assistant and model connections
- settings/status/local runtime controls
- device-local media binding
- Team Web Gateway lifecycle
- Timeline editing/persistence
- delivery/FCP integration

These are code-parity statements. Any gate marked `native_smoke_required` in `phase7-parity.json` still requires real-machine evidence.

## Packaged runtime blocker

A source checkout being runnable does not prove a distributable Desktop app can launch its Python Core.

The packaging workstream must produce a self-contained runtime containing:

- MirrorOrder Python Core
- the first-party multicam engine
- Python 3.11+ with `numpy`, `pandas`, and `scipy`
- `ffmpeg` and `ffprobe`

The base installer does not need to bundle optional model weights or every optional ML runtime.

Packaged mode is fail-closed: it must not silently fall back to the user's global Python or FFmpeg toolchain.

## Required release-quality gates

These gates remain required **after** SwiftUI removal.

### Cross-platform local gate

```bash
cd desktop-v2
npm install
npm run verify:rc
```

The underlying checks include TypeScript typecheck/tests/build, Rust Timeline/Tauri checks and Python compile/tests.

### Packaged runtime gate

On `feat/desktop-v2-runtime-packaging`, using the actual platform/architecture release payloads:

```bash
cd desktop-v2
MIRRORORDER_PORTABLE_PYTHON_ROOT=<portable-python> \
MIRRORORDER_MEDIA_TOOLS_ROOT=<ffmpeg-tool-root> \
npm run stage:runtime
```

The staging contract verifies the hard Python modules, FFmpeg/FFprobe, first-party multicam files, self-contained symlinks and post-copy relocation.

### macOS native gate

- `cargo tauri build` with the actual staged macOS runtime
- launch without dependence on the developer checkout/Homebrew/system Python/FFmpeg
- packaged Production Host launch
- project create/open/delete
- real media bind/playback
- real multicam sync
- Timeline persistence/recovery smoke
- Finder reveal
- delivery export
- Final Cut Pro open/import smoke
- Team Web Gateway launch/stop and second-device LAN pairing/trusted-LAN smoke
- codesign/notarization/bundle/update smoke

### Windows native gate

- `cargo tauri build` with the actual staged Windows runtime
- install/launch without dependence on the developer checkout/global Python/FFmpeg
- packaged Production Host launch
- project create/open/delete
- real media bind/playback through WebView2/proxy path
- real multicam sync, including symlink/layout behavior
- Timeline persistence/recovery smoke
- Explorer reveal
- Team Web Gateway launch/stop and second-device LAN pairing/trusted-LAN smoke
- installer/update/uninstall smoke

Resolve/Premiere integration remains an extension point and is not part of this cutover.

## No rollback client

The project no longer maintains the old SwiftUI app as a fallback. If Desktop v2 has a native release bug, the fix belongs in Desktop v2 or its isolated runtime/platform workstream.

## Current state

- Desktop v2: **sole Desktop implementation**
- SwiftUI: **removed by owner cutover**
- native release gates: **still required and not to be faked as passed**
- packaged Python/media runtime: **isolated blocker until target-package smoke passes**
- Team Web business/review boundary: unchanged
- Python Core authority: unchanged
