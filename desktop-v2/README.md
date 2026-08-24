# MirrorOrder Desktop v2

Desktop v2 is the Tauri 2 + React/TypeScript primary desktop candidate for MirrorOrder. It deliberately keeps the existing Python Core as the business/AI authority while moving deterministic editing state into a standalone Rust Timeline Core.

Phase 7 cutover policy is defined in:

- `phase7-parity.json`
- `../docs/desktop-v2-phase7-cutover.md`
- `../macos-app/LEGACY.md`

SwiftUI is frozen as a regression reference and must not be physically deleted until the native release gates pass.

## Local development gates

GitHub Actions are not required for normal validation. Run locally:

```bash
npm install
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

With an existing Python Host on `127.0.0.1:8765`:

```bash
npm run smoke:host
```

Python tests remain at repository root:

```bash
pytest
```

## Authority boundary

- **Python Core** owns workspace/project lifecycle, Review, Slate, Identity, Assistant, model connections, AI proposals, media identity/binding semantics and FCPXML delivery semantics.
- **React/TypeScript** owns desktop interaction, workbench layout, typed localhost clients and proposal preview.
- **Tauri/Rust** owns Python Host lifecycle, native dialogs/filesystem/platform adapters and Rust Timeline state.
- **Rust Timeline Core** owns deterministic edit state, validation, undo/redo, persistence and recovery.
- **Team Web** remains a lightweight reviewer/projection surface.
- Video frames/proxy bytes are never transported through Tauri JSON/Base64 IPC.

## Python Host lifecycle

Tauri launches the existing Core through:

```text
python3 -m script_organizer.cli serve <workspace> --local-only --port 8765
```

Windows defaults to `python`. Development overrides:

```text
MIRRORORDER_PYTHON
MIRRORORDER_CORE_ROOT
```

The Host bridge refuses to silently attach to an unrelated process that already owns the selected port.

## Phase 2 — Material / Script

The production workbench consumes `review.v1` and existing atomic ReviewStore writes.

Implemented:

- candidate / pending / placed / rejected status filters;
- true fixed-row virtualized Take list;
- Take → episode coarse placement with valid `episode-only` completion;
- Take → exact non-heading script block placement;
- explicit clear-human-placement path without erasing automatic evidence;
- Take ↔ script navigation;
- A/B/C angle-level shot type only from clip-level projection;
- local Host media playback honoring source ranges;
- candidate evidence cards with dialogue/sequence/context score, margin, method and evidence;
- AI evidence remains non-authoritative until explicit human placement.

## Phase 3 — Slate / Identity / Assistant

### Slate

Desktop directly reuses the existing Script Supervisor parser/store:

- `EP3`, `12-3-2`, `同场下一条`, `B近`, `看片再定` remain first-class rough input;
- writes are revision-safe sparse patches;
- camera-specific shot facts map to the real angle `clip_id`;
- generic shot labels are never copied across A/B/C;
- range hints remain notes until a human supplies real seconds.

### Identity

Desktop exposes device-local identity evidence and explicit human confirmation. Embeddings never leave the Python device-local store. Role inference stays suggestion-only until confirmed.

Identity occurrence rows can jump directly back to the corresponding Material Take.

### Assistant

Desktop consumes the existing first-party Assistant status/cycle/message APIs and also exposes device-local text/vision/embedding model connection settings. API keys are never returned to React after save.

Assistant output cannot directly bypass Review, Editorial Decision or FCPXML authority.

## Phase 4 — Rust Timeline Core + Persistence v2

The standalone engine lives at:

```text
src-tauri/crates/timeline-core/
```

Editing time is integer frames. Core model includes Source, MulticamGroup, Sequence, Track, TimelineClip, Marker and Transition.

Deterministic commands:

```text
insert
overwrite
move
split
trim
ripple_delete
disable
multicam_switch
set_marker
undo
redo
```

Every command is validated and rejected commands roll back.

The Tauri bridge keeps React from owning a second Timeline truth. Rough-cut seed flow remains:

```text
Python rough_cut_plan.v1
        ↓
proposal preview
        ↓
explicit human confirmation
        ↓
transactional Rust command batch
```

Only `selection_status = explicit_best` is eligible for automatic seed commands. Conflicts and editorial-choice rows remain skipped.

### Persistence v2

Timeline edit state is device-local and uses:

```text
checkpoint.json
journal.jsonl
checkpoint.json.bak
```

Persistence v2 adds a generation ID plus monotonic journal sequence/checkpoint sequence. Recovery replays only entries belonging to the active generation and later than the checkpoint boundary, preventing duplicate replay if a crash occurs after checkpoint replacement but before journal truncation.

The workbench attempts persisted recovery when opened and exposes checkpoint/journal status in Settings / Status.

## Phase 5 — Editing Workbench

The current proxy-first editing surface includes:

- Timeline track blocks and playhead;
- Source Monitor;
- Program Monitor;
- local media endpoint playback;
- waveform derived from local ffmpeg PCM peaks;
- J / K / L WebView proxy transport;
- ±1 frame stepping;
- split / trim / move / ripple delete / enable-disable;
- multicam angle switch;
- markers;
- undo / redo;
- rough-cut proposal seed.

Current J/K/L and monitor transport are explicitly the **WebView proxy gate**, not the final native A/V clock. Native media timing remains a later release-quality gate.

## Phase 6 — Platform / Delivery

Tauri platform adapters now expose:

- native file/folder dialogs;
- Finder reveal/open on macOS;
- Explorer reveal/open on Windows;
- `xdg-open` fallback on Linux;
- macOS Final Cut adapter for existing `.fcpxml` files;
- explicit capability reporting for pending security-scope / Resolve / Premiere extensions.

Delivery remains Python-owned:

```text
Desktop explicit action
        ↓
Python fcpxml_exporter
        ↓
selection_manifest.json / organized.fcpxml
        ↓
Tauri reveal / Final Cut adapter
```

The current exporter protects synchronized multicam structure. `organized.fcpxml` remains a safe source-preserving copy while delivery decisions live in `selection_manifest.json`; Desktop does not pretend the manifest has already been injected into FCPXML.

## Phase 7 — Desktop primary candidate

### Project lifecycle

Desktop now uses the existing Python `WorkspaceRegistry` for:

- native script/FCPXML/media-root selection;
- `preflight_create`;
- create;
- optional `prepare_project` submission;
- guarded delete requiring echoed `project_id`;
- workspace refresh after mutation.

### Device-local Media Binding

`media_binding.v1` exposes the existing `DeviceMediaStore` through a Host-local adapter:

- read roots and resolved/missing inventory;
- append roots + scan;
- replace roots + rescan;
- verified content media ID first;
- unique filename fallback only for provisional legacy IDs;
- no shared workspace/Review mutation.

### Settings / Status

`desktop_status.v1` exposes diagnostic facts only:

- Python executable/version;
- ffmpeg / ffprobe / llama-server availability;
- required/optional Python modules;
- workspace writability;
- multicam engine status/origin;
- identity runtime readiness;
- device media state path.

React combines that with Tauri platform capability state and Rust Timeline persistence state.

### SwiftUI retirement

Current state:

```text
Desktop v2  → primary candidate / Phase 7 RC
SwiftUI     → legacy frozen regression reference
Team Web    → unchanged lightweight reviewer
Python Core → unchanged authority
```

Do not physically delete `macos-app/` until the native release gates in `phase7-parity.json` pass, especially packaged Tauri build, real media playback/binding, Timeline recovery, macOS Final Cut smoke, codesign/bundle, Windows WebView2 and installer smoke.
