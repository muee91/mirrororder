# 镜序 Desktop v2 Phase 4 Codex Handoff

Date: 2026-08-25

## Current direction

Continue `feat/desktop-v2-tauri`.

Do not revisit Swift/Tauri selection. Do not rewrite Python Core. Keep Team Web as projection layer.

Architecture boundary:

- React/TypeScript: Desktop UI and interaction surfaces.
- Tauri/Rust: native host and Timeline Core.
- Python Core: review authority, script supervisor, identity, assistant, rough-cut proposal.

## Completed milestones

### Phase 1

- Tauri 2 + React/TypeScript skeleton.
- HostConnection typed client.
- Python Host lifecycle bridge.
- Desktop development runbook and contract tests.

### Phase 2

Implemented production material/script workflow:

- review.v1 projection consumption.
- Take list virtualization.
- Episode filtering.
- AI candidate / pending / placed / rejected states.
- episode-only placement.
- precise script segment placement.
- human placement clear.
- angle-level clip metadata handling.
- playback endpoint abstraction through HostConnection.

Important rule:

`episode-only` is valid completion. Do not force scene/shot/script segment completeness.

### Phase 3

Desktop bridges/pages for:

- script supervisor workflows.
- identity/person evidence.
- assistant status/cycle/message.

Keep all authority in Python Core.

### Phase 4 Timeline Core

Implemented direction:

```
Python rough_cut_plan.v1
        |
        v
human review / confirmation
        |
        v
Rust TimelineCommand
        |
        v
Timeline Core
```

Timeline Core responsibilities:

- Sequence
- Track
- Clip
- Marker
- Multicam group
- deterministic edit commands
- validation
- undo/redo

Commands:

- insert
- overwrite
- move
- split
- trim
- ripple_delete
- disable
- multicam_switch
- set_marker
- undo
- redo

## Next work

Finish Phase 4 stabilization:

1. Timeline persistence.
2. Command journal.
3. Crash recovery.
4. Serialization roundtrip tests.
5. Strong validator coverage.
6. Local build/test verification without GitHub Actions.

Then move to Phase 5:

- Program Monitor.
- Source Monitor.
- Proxy playback.
- J/K/L controls.
- waveform.
- frame accurate editing.

## Validation policy

Do not rely on GitHub Actions because quota is unavailable.

Prefer local:

```
npm run typecheck
npm test
npm run build
cargo test
```

Before claiming completion, verify actual local results.
