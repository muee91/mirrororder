# MirrorOrder Desktop v2 Phase 7 Cutover

Branch: `feat/desktop-v2-tauri`

Phase 7 is a **retirement/cutover phase**, not a new business-feature phase. Desktop v2 becomes the primary desktop implementation only after the parity gates below are code-complete. The legacy SwiftUI application remains a frozen regression reference until the native release gates pass on real macOS and Windows machines.

## Authority boundaries remain frozen

- Python Core remains authority for workspace/project lifecycle, Review, Slate, Identity, Assistant, AI proposals, media identity/binding semantics and FCPXML delivery semantics.
- Rust Timeline Core remains authority for local timeline edit state, deterministic edit commands, persistence and recovery.
- React/TypeScript remains the production UI and only talks to the existing Python Core through typed localhost contracts, plus narrow Tauri native commands.
- Team Web remains a lightweight reviewer/projection surface.
- SwiftUI is not allowed to receive new product features after Phase 7 RC.

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

The Desktop page combines those facts with Tauri platform capabilities and Rust Timeline persistence status.

### Media binding

`media_binding.v1` delegates to the existing `DeviceMediaStore`:

- read roots and resolved/missing inventory,
- append roots and scan,
- replace roots and rescan,
- content-media-ID matching first,
- unique-filename fallback only for provisional legacy IDs,
- device-local state only; no shared workspace or Review mutation.

### macOS FCP integration

Desktop delivery reuses the existing Python exporter and the narrow macOS Tauri Final Cut adapter. The exporter still protects synchronized multicam structure; `selection_manifest.json` carries delivery decisions until a structure-specific safe FCPXML writer exists.

## SwiftUI retirement policy

`macos-app/` is now a **legacy frozen regression reference**.

Do not:

- add new product features to SwiftUI,
- make SwiftUI the source of a new business rule,
- delete SwiftUI only because Desktop v2 is code-complete.

Physical deletion is allowed only after all native release gates below pass.

## Required release gates before deletion

### Cross-platform local gate

```bash
cd desktop-v2
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

### macOS native gate

- `cargo tauri build`
- Python Host launch from the packaged app
- open/create/delete a real project
- bind and replay real media
- Timeline persistence/recovery smoke
- Finder reveal
- delivery export
- Final Cut Pro open/import smoke
- codesign/bundle/update smoke

### Windows native gate

- `cargo tauri build`
- Python Host launch from the packaged app
- open/create/delete a real project
- bind and replay real media through WebView2/proxy path
- Timeline persistence/recovery smoke
- Explorer reveal
- installer/update smoke

Resolve/Premiere integration stays an extension point and is not a Phase 7 retirement blocker.

## Current cutover state

- Desktop v2: **primary candidate / Phase 7 RC**
- SwiftUI: **legacy frozen reference**
- SwiftUI physical deletion: **blocked by native release gates**
- Team Web: unchanged
- Python Core authority: unchanged
