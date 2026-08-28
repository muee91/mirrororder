# MirrorOrder Desktop

`desktop/` is the current and only Desktop development baseline on `main`.

## Architecture

- React / TypeScript — Production UI
- Tauri 2 / Rust — desktop lifecycle and narrow platform adapters
- Rust Timeline Core — authoritative local timeline edit state
- Python MirrorOrder Core — project / Review / Slate / Identity / Assistant / media / FCPXML business authority
- Team Web — separate lightweight Review / Collaboration surface

Start with the repository documentation authority index:

- `../docs/README.md`
- `../docs/app-information-architecture.md`
- `../docs/ux-principles.md`
- `development-baseline.json`
- `../docs/desktop-development-baseline.md`

## Product surfaces

Production project navigation is fixed by the current IA:

```text
素材：场记 / 素材库 / Take / 人物
剧本：剧本 / 覆盖
剪辑：粗剪 / 组接 / 时间线 / 交付
审阅：看片 / 待处理 / 概览
```

New projects start at **素材 → 场记**. Existing projects restore the last Production page.

Global surfaces sit outside project navigation:

- 状态中心 — durable tasks, failures, retry and recent completion history;
- 团队审阅 — Team Web collaboration workspace;
- 设置 — Team Web preferences, local runtimes, external/custom model connections, collaboration access and advanced diagnostics.

`⌘K / Ctrl+K` is project semantic search. 小镜 is a contextual right-side drawer. Model Provider / Base URL / API Key configuration belongs to Settings, not the Assistant drawer.

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

A gate is only PASS if it actually ran successfully on the tested commit.

## Authority boundary

- **ReviewStore** owns human script placement / mapping.
- **Script Supervisor / Slate** owns production evidence and slate facts; it must not silently rewrite Review placement or Editorial Reject.
- **Python Core** owns workspace/project lifecycle, Review, Slate, Identity, Assistant, model connections, AI proposals, media identity/binding semantics, Team Web review/security semantics and FCPXML delivery semantics.
- **React/TypeScript** owns desktop interaction, workbench layout, typed localhost clients and proposal preview.
- **Tauri/Rust** owns Python process lifecycle, native dialogs/filesystem/platform adapters and the Rust Timeline bridge.
- **Rust Timeline Core** owns deterministic edit state, validation, undo/redo, persistence and recovery.
- **Team Web** remains a lightweight reviewer/collaboration surface and never receives local model secrets, device paths, Timeline authority or Final Editorial Decision authority.
- Video/proxy frames are not transported through Tauri JSON/Base64 IPC.

AI authority remains:

```text
evidence → proposal → human confirmation → authority
```

Audit, retrieval scores and Individual Opinion remain evidence/advice, not final editorial truth.

## Status and settings contracts

- `StatusCenterWorkbench` is the single global durable-task surface. Project workbenches may show lightweight progress or failure hints, but must not grow parallel task controllers.
- Settings should show normal user configuration first. Python executable, Host process details, release gates, Timeline journal paths and similar engineering data belong in the advanced diagnostics disclosure.
- Local runtime status uses user-facing state names; raw provider/runtime state should not dominate the normal settings experience.
- External/custom model connection secrets remain device-local and are never echoed back into project/shared data.

## Managed services

Production Host and Team Gateway have independent lifecycle managers. `spawn()` and a merely open TCP port are insufficient health evidence; readiness should verify `/api/v1/ping` returns the expected MirrorOrder service identity and `status=ok`.

## Feature isolation

Production project tabs are product surfaces, not generic plugin slots.

Runtime packaging, heavy media processing, automatic music, new NLE adapters, model-runtime infrastructure and experimental automation should start in isolated branches/worktrees when they have their own runtime/process/security boundary. Promote them only after typed contracts, authority boundaries, failure isolation and native smoke gates are explicit.
