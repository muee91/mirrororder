# MirrorOrder Desktop v2

Desktop v2 is the Tauri 2 + React/TypeScript shell for MirrorOrder. It deliberately keeps the existing Python Core as the business and AI authority.

## Development gates

```bash
npm install
npm run typecheck
npm test
npm run build
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

## Phase 2 material / script slice

The first writable Phase 2 slice consumes the existing `review.v1` projection and the existing atomic ReviewStore API. React does not recompute placement authority.

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

## Authority boundary

- React/TypeScript owns desktop interaction, filters, virtualization and typed API projections.
- Tauri/Rust owns native lifecycle and platform integration.
- `src/script_organizer/` remains the business/AI authority.
- Manual placement writes go through the existing Python `ReviewStore`; React does not write project files directly.
- Automatic candidates, audit evidence and context do not become review authority until an explicit human placement action.
- Media bytes are not transported through Tauri JSON IPC.
- Team Web remains the lightweight Review projection.
