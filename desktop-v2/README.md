# MirrorOrder Desktop v2

Desktop v2 is the Tauri 2 + React/TypeScript shell for MirrorOrder. It deliberately keeps the existing Python Core as the business and AI authority while moving deterministic editing state into a standalone Rust Timeline Core.

## Development gates

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

With an existing Python Host already running on `127.0.0.1:8765`:

```bash
npm run smoke:host
```

Override the smoke target when needed:

```bash
MIRRORORDER_HOST_URL=http://127.0.0.1:9000 npm run smoke:host
```

## Python Host lifecycle

The Tauri Host starts the existing Core through:

```text
python3 -m script_organizer.cli serve <workspace> --local-only --port 8765
```

On Windows the default executable is `python`. Development overrides:

```text
MIRRORORDER_PYTHON
MIRRORORDER_CORE_ROOT
```

`start_python_host` refuses to launch when the selected loopback port is already occupied. This prevents “start and connect” from accidentally attaching to an unrelated workspace that happens to own the same port; use the explicit “connect Host” path for an already-running service.

## Phase 2 — material / script

The writable Phase 2 slice consumes the existing `review.v1` projection and atomic ReviewStore API. React does not recompute placement authority.

Current behavior:

- status filters: AI/algorithm candidate, pending placement, placed, and rejected;
- the first 32 episodes remain directly clickable;
- Take rows use a fixed-row virtual viewport instead of mounting the whole project;
- Take → script navigation prioritizes effective mapping, then candidate evidence, then context;
- script blocks link back to related Takes without promoting candidate/context evidence to authority;
- dragging a Take onto an episode writes `set_group_placement` with only `episode_ids` — `episode-only` is a valid completed placement;
- dragging a Take onto a non-heading script block writes precise `script_segment_ids` placement;
- the selected Take can also be placed by an explicit script-block button for a non-drag interaction path;
- clearing a human placement clears only that manual placement; automatic state remains separate;
- candidate rows are evidence only. The user reviews the preferred candidate in the script view before an explicit placement write;
- A/B/C shot size is rendered only from existing clip-level `audit_runtime` projection. No Take-level shot-size fallback is allowed;
- media playback uses the single-Host `/api/v1/projects/{project_id}/media/{clip_id}` endpoint and honors `source_start` / `source_end`.

Review writes require a local reviewer nickname. The nickname is kept in device-local browser storage for convenience and is sent as the ReviewStore actor; it is not written into project configuration.

## Phase 3 — slate / identity / assistant

The project workbench now has dedicated `场记`, `人物`, and `小镜` surfaces.

### Slate

- reads/writes the existing `script_supervisor.v2` store;
- quick input delegates to the existing deterministic/model-assisted script-supervisor parser;
- rough notes such as `EP3`, `12-3-2`, `同场下一条`, `B近`, `前半段可用`, and `看片再定` remain first-class input;
- writes use `expected_revision` + actor and surface 409 conflicts instead of overwriting concurrent work;
- quick notes are sparse patches: unmentioned existing human facts survive;
- camera-specific shot facts are mapped to the real angle `clip_id`;
- a generic shot label is never copied across A/B/C;
- range hints remain notes until a human supplies real seconds — the UI never invents timecodes.

### Identity

The Python Core already owned device-local clustering and human confirmation through `IdentityLibrary`. Desktop v2 adds only a localhost adapter:

```text
GET  /api/v1/projects/{project_id}/identities?kind=face|speaker
POST /api/v1/projects/{project_id}/identities
```

The adapter never exposes embeddings. Role candidates remain suggestions; `label` / `role_name` become confirmed only after the user submits an explicit update. Confirmed human labels remain protected from later automatic cluster refreshes by the existing IdentityLibrary rules.

### Assistant

The native workbench consumes the existing first-party assistant endpoints:

```text
GET  /api/v1/projects/{project_id}/assistant
POST /api/v1/projects/{project_id}/assistant/cycle
POST /api/v1/projects/{project_id}/assistant/message
```

The UI can inspect the production attention queue, refresh a cycle, and ask project-grounded questions. It does not gain direct review, Editorial Decision, Delivery, or FCPXML authority.

## Phase 4 — Rust Timeline Core

The deterministic editing engine lives at:

```text
src-tauri/crates/timeline-core/
```

It is a standalone Rust crate and has no React or Python dependency. Editing time is represented as integer frames.

### Model

`TimelineProject` contains:

- `Source`
- `MulticamGroup`
- `Sequence`
- `Track` (`video` / `audio`)
- `TimelineClip`
- `Marker`
- `Transition`

Projects and commands are Serde contracts and are round-trip testable independently of Tauri.

### Deterministic commands

The current command set is:

- `insert`
- `overwrite`
- `move`
- `split`
- `trim`
- `ripple_delete`
- `disable`
- `multicam_switch`
- `set_marker`
- `undo`
- `redo`

Every successful command is followed by Timeline validation. A command that would create overlap, exceed a known source range, reference an unknown source/multicam angle, or otherwise violate the model is rolled back.

Undo/redo currently stores project snapshots. This intentionally favors correctness and deterministic recovery over memory optimization; delta history can replace the storage strategy without changing the command contract later.

### Tauri bridge

Tauri owns the active Timeline engine through `TimelineManager` and exposes typed commands:

```text
timeline_new
timeline_load
timeline_load_with_commands
timeline_snapshot
timeline_apply
timeline_apply_batch
timeline_undo
timeline_redo
timeline_validate
```

`timeline_apply_batch` is transactional. `timeline_load_with_commands` builds and validates a new engine off to the side, applies the full command batch, and replaces the active Timeline only if everything succeeds; a failed rough-cut seed cannot destroy the current edit.

### Python proposal → human confirmation → Rust command

Phase 4 uses the existing read-only `rough_cut_plan.v1` as a proposal source:

1. Python Core builds the rough-cut plan from coverage, delivery, script-supervisor, review, and editorial facts.
2. React previews it but accepts only `selection_status = explicit_best` rows for automatic seeding.
3. Conflicts, missing eligible Takes, and `needs_editorial_choice` rows stay visibly skipped; React never invents a creative Best.
4. The user explicitly clicks **确认建立时间线**.
5. React converts the confirmed rows to deterministic `insert` commands and sends one transactional seed to Rust.
6. Rust validates/applies the commands and becomes the Timeline state authority.

When script-supervisor `preferred_clip_id` and `usable_range` exist, the proposal uses those human facts. Otherwise the proposal falls back to the full Take range and warns that it still needs editorial trimming.

The Phase 4 UI exposes track blocks, frame playhead, split, trim, move, ripple delete, enable/disable, multicam angle switch, markers, undo/redo, and validator status. Source/Program monitors, waveforms, J/K/L playback, frame-accurate interactive trim, proxies, and full keyboard editing remain Phase 5 work.

The proposal currently defaults to a 24/1 integer-frame timebase because `review.v1` does not yet project the native project timebase. This is explicitly shown as a proposal warning; the Phase 5 media/platform adapter should replace it with the project-native rate rather than silently assuming it.

## Authority boundary

- React/TypeScript owns desktop interaction, filters, virtualization, proposal preview, and typed API/command bridges.
- Tauri/Rust owns native lifecycle, active Timeline state, deterministic edit commands, undo/redo, and validation.
- `src/script_organizer/` remains the business/AI/review/slate/identity/assistant authority.
- Manual placement writes go through the existing Python `ReviewStore`; React does not write project files directly.
- Automatic candidates, audit evidence, assistant output, context, and rough-cut plans do not become review/edit authority until an explicit human action.
- Timeline Core does not decide which Take is creatively Best; it executes deterministic commands after confirmation.
- Media bytes are not transported through Tauri JSON IPC.
- Team Web remains the lightweight Review projection and does not load the full native assistant or Timeline engine.
