# MirrorOrder Desktop

`desktop/` is the current and only Desktop development baseline on `main`.

## Architecture

- React / TypeScript — production UI
- Tauri 2 / Rust — desktop lifecycle and narrow platform adapters
- Rust Timeline Core — authoritative local timeline edit state
- Python MirrorOrder Core — project/review/slate/identity/assistant/media/FCPXML business authority
- Team Web — separate lightweight review/projection surface

Machine-readable baseline:

- `development-baseline.json`
- `../docs/desktop-development-baseline.md`

## Local validation

GitHub Actions are not required for normal development validation.

```bash
npm install
npm run verify:rc
```

Or run individual gates:

```bash
npm run check:baseline
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Python tests remain at repository root:

```bash
python -m pytest -q
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

## Product surfaces

The Desktop baseline includes:

- project create/open/delete
- material/script placement and evidence
- script supervisor / slate
- identity confirmation and role suggestions
- assistant and model connections
- device-local media binding
- settings / status / local runtime controls
- Rust Timeline Core with persistence, journal and recovery
- Source / Program Monitor proxy workbench
- keyboard transport and deterministic edit commands
- Team Web Gateway top-level workspace
- FCPXML delivery and macOS Final Cut adapter

## Feature isolation

Production project tabs are product surfaces, not generic plugin slots.

Heavy capabilities start outside the main workbench when they have their own runtime/process/security boundary. Current isolated workstreams:

```text
work/runtime-packaging
work/auto-score
```

Runtime packaging, heavy media processing, new NLE adapters, model-runtime infrastructure and experimental automation should only be promoted after their typed contract, authority boundary, failure isolation and native smoke gates are explicit.
