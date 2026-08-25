# MirrorOrder Desktop v2

Desktop v2 is the sole Desktop implementation on `main`.

Architecture:

- React / TypeScript — production UI
- Tauri 2 / Rust — desktop process lifecycle and narrow platform adapters
- Rust Timeline Core — authoritative local timeline edit state
- Python MirrorOrder Core — project/review/slate/identity/assistant/media/FCPXML business authority
- Team Web — lightweight reviewer/projection surface

The former SwiftUI `macos-app/` client was removed by owner-directed Phase 7 cutover. Native release gates remain required for Desktop v2 quality, but no legacy client is retained as a fallback.

## Phase 7 state

Machine-readable state:

- `phase7-parity.json`
- `../docs/desktop-v2-phase7-cutover.md`

Heavy runtime packaging remains isolated on:

```text
feat/desktop-v2-runtime-packaging
```

## Local validation

GitHub Actions are not required for normal development validation.

```bash
npm install
npm run verify:rc
```

Or run individual gates:

```bash
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Python tests remain at repository root:

```bash
pytest
```

With an existing local Production Host:

```bash
npm run smoke:host
```

## Authority boundary

- **Python Core** owns workspace/project lifecycle, Review, Slate, Identity, Assistant, model connections, AI proposals, media identity/binding semantics, Team Web review/security semantics and FCPXML delivery semantics.
- **React/TypeScript** owns desktop interaction, workbench layout, typed localhost clients and proposal preview.
- **Tauri/Rust** owns Python process lifecycle, native dialogs/filesystem/platform adapters and Rust Timeline state.
- **Rust Timeline Core** owns deterministic edit state, validation, undo/redo, persistence and recovery.
- **Team Web** remains a lightweight reviewer/projection surface; Desktop owns only its isolated launch/lifecycle UX.
- Video/proxy frames are not transported through Tauri JSON/Base64 IPC.

AI authority remains:

```text
evidence → proposal → human confirmation → authority
```

## Feature isolation

Production project tabs are product/parity surfaces, not generic plugin slots.

Capabilities with their own heavy runtime, process or security boundary should start in an isolated module and, for substantial changes, an isolated branch/worktree.

Examples:

- runtime packaging
- heavy media processing
- new NLE adapters
- model-runtime infrastructure
- experimental automation engines

Promotion requires an explicit typed contract, ownership boundary, failure isolation and native smoke gate.

## Production Host

Default local Host:

```text
127.0.0.1:8765
```

Tauri launches the existing Python Core:

```bash
python -m script_organizer.cli serve <workspace> --local-only --port 8765
```

Development overrides:

```text
MIRRORORDER_PYTHON
MIRRORORDER_CORE_ROOT
```

The bridge refuses to silently attach to an unrelated process occupying the selected port. A spawned Python process is only reported as running after the loopback port is actually listening.

## Team Web Gateway

Team Web uses an isolated process manager and defaults to:

```text
8766
```

It supports multiple workspaces, local-only/LAN operation, pairing code and trusted-LAN modes.

Stopping Team Web does not stop the Production Host.

## Material / Script

Implemented behavior includes:

- rough episode placement
- exact script placement
- episode-only as valid completed human placement
- candidate / pending / placed / rejected separation
- angle-level shot size
- candidate evidence breakdown
- virtualized Take list
- media playback and dialogue evidence

Human placement remains authoritative over candidates.

## Slate

Desktop uses the existing Python Script Supervisor parser and revision-safe writes.

Rough handwritten notes remain first-class. Camera-specific facts resolve to angle/clip-level facts rather than being copied to every Take angle.

## Identity

Identity UI supports face/speaker evidence, role suggestions and explicit human confirmation. Embeddings stay device-local and are not exposed to React.

## Assistant

Desktop exposes project assistant status, attention items, messages and model connection settings. Assistant output does not bypass Review or Editorial Decision authority.

## Media binding

Device-local media roots and bindings are handled by the existing Python `DeviceMediaStore`.

Bindings are local to each device and do not rewrite shared project facts.

## Timeline Core

The standalone Rust core uses integer frame time and supports:

- Insert
- Overwrite
- Move
- Split
- Trim
- RippleDelete
- Disable
- MulticamSwitch
- SetMarker
- Undo / Redo

Tauri persistence provides checkpoint, append-only journal and crash recovery. React is not a timeline source of truth.

## Proxy editor workbench

Current editor surface includes:

- Source Monitor
- Program Monitor
- waveform projection
- J / K / L proxy transport
- frame stepping
- playhead
- split / trim / move / ripple delete
- multicam switching
- markers

The WebView proxy transport is not equivalent to a final native A/V clock; real-platform playback remains a release smoke gate.

## Platform and delivery

Narrow platform adapters cover Finder/Explorer reveal/open behavior and macOS Final Cut handoff. FCPXML generation remains in Python Core.

Resolve/Premiere adapters remain extension points and are not part of the current cutover gate.

## Runtime packaging

Packaging is intentionally isolated from the main workbench. The target distributable runtime must explicitly carry:

- MirrorOrder Python Core
- Python 3.11+
- numpy / pandas / scipy
- ffmpeg / ffprobe
- first-party multicam sync engine

Packaged mode must not silently fall back to system Python or system FFmpeg.

See `../docs/desktop-v2-runtime-packaging.md` and `phase7-parity.json`.

## Release gates still outstanding

SwiftUI removal does not imply these are passed:

- macOS Tauri build and packaged Host smoke
- Windows Tauri build and packaged Host smoke
- real media playback
- real multicam sync
- Timeline recovery smoke
- Final Cut import on macOS
- Team Web LAN second-device smoke
- codesign/notarization or Windows installer/update smoke

Use real local machines to close these gates; GitHub Actions are optional infrastructure, not a semantic requirement.
