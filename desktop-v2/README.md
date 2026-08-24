# MirrorOrder Desktop v2

Desktop v2 is the Tauri 2 + React/TypeScript shell for MirrorOrder. It deliberately keeps the existing Python Core as the business and AI authority.

## Phase 1 commands

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

## Boundary

- React/TypeScript owns desktop interaction and typed API projections.
- Tauri/Rust owns native lifecycle and platform integration.
- `src/script_organizer/` remains the business/AI authority.
- Media bytes are not transported through Tauri JSON IPC.
- Team Web remains the lightweight Review projection.
