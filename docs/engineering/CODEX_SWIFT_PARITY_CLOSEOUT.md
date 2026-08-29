# Codex Closeout — Swift Golden Product Parity

## Scope

This document closes `feature/swift-golden-product-parity` as fast as possible.

The product-layer recovery is source-frozen. Do **not** add new product scope unless an executable gate proves a regression that requires a fix.

Current parity goals already implemented on this branch:

- Project Home first after workspace resume.
- Golden multicam Slate with A/B/C/Aux columns, direct record editing, blank records, Take import, same-scene-next, inherit-previous, Inspector, playback, I/O, preferred angle and per-angle metadata.
- Finder / Explorer explicit file drop to device-local media identity without persisting device paths into project/shared artifacts.
- Review placement retained only as an auxiliary pool; no second production Slate table.
- Golden Material / Script three-column workflow with revision-safe rough placement and precise script placement.
- Shared `MirrorOrderMediaCard` used by Slate / Take / Inspector; `AngleEvidenceCard` is only an adapter.
- Project context actions: Team Review, Finder/Explorer reveal, Local Media / replace media roots, durable prepare/reorganize.
- Desktop Appearance: System / Light / Dark as device-local UI preference, separate from Team Web settings.
- Slate transport shortcuts: Space, J, K, L.
- Swift Golden parity source contracts and targeted executable evidence.

Do not restore SwiftUI as the product runtime. Python remains Production authority; Rust remains Timeline edit authority; React/Tauri remains UI/device integration.

## Starting point

Repository: `muee91/mirrororder`

Branch:

```bash
git fetch origin
git checkout feature/swift-golden-product-parity
git pull --ff-only origin feature/swift-golden-product-parity
```

Before doing anything else:

```bash
git status --short
git log -1 --oneline
```

The worktree must be clean before validation.

## Phase A — Native Desktop source gates

Run exactly:

```bash
cd desktop
npm install
npm run typecheck
npm test
npm run build
cd ..
```

Acceptance:

- TypeScript compile: PASS.
- Native Vitest: PASS, including the new parity, appearance, project action, rough placement and Slate playback tests.
- Vite build: PASS.

If a test fails:

1. Fix the actual regression.
2. Do not delete or weaken parity tests to get green.
3. Do not remove A/B/C/Aux Slate columns.
4. Do not reintroduce automatic opening of the last project after workspace resume.
5. Do not create a second Slate, Review or Timeline authority in React.
6. Re-run `npm run typecheck && npm test && npm run build`.

## Phase B — Python / Rust / Tauri repository gates

From repo root run, in order:

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

Do not inherit PASS from `feature/timeline-audio-ux`.

Acceptance:

- All three commands PASS on the current parity commit.
- Rust Timeline/Tauri tests executed by the repository gates remain green.
- A third-party deprecation warning may be recorded, but failed first-party contracts may not be ignored.

High-risk contracts to inspect first if a gate fails:

- `src/script_organizer/slate_media_runtime.py`
- `src/script_organizer/project_location_runtime.py`
- `src/script_organizer/rough_placement_runtime.py`
- `src/script_organizer/runtime_stack.py`
- `desktop/src/features/slate/GoldenSlateWorkbench.tsx`
- `desktop/src/app/desktopAppearance.ts`
- `desktop/src/desktop-theme.css`

## Phase C — Packaged macOS validation

Run:

```bash
cd desktop
npm run stage:runtime
npm run verify:rc
npm run tauri -- build
npm run verify:macos-bundle
cd ..
```

Then launch the packaged App, not only Vite dev mode.

### Required product-parity smoke

Verify manually in the packaged app:

1. Workspace resume lands on Project Home instead of automatically entering the last project.
2. Project card opens the selected project.
3. Sidebar context menu exposes:
   - Team Review
   - Finder reveal
   - Local Media / replace media roots
   - Reorganize / prepare project
4. Golden Slate is the main Slate surface.
5. Slate has separate A/B/C/Aux media columns.
6. Blank record creation works without a Take.
7. Direct episode/scene/shot/take/status editing saves through Script Supervisor authority.
8. Inspector displays all angle media cards.
9. Preferred angle saves as Slate preference and is not presented as Editorial Best.
10. I/O stores an explicit human usable range.
11. Space/J/K/L affect only the Slate player and do not fire while typing in an input/textarea/select.
12. Finder drag-drop resolves media identity, attaches to the dirty Slate row, and does not persist the absolute device path into shared project artifacts.
13. Local Media page opens from the project context action.
14. Reorganize submits a durable `prepare_project` task and routes to Status Center instead of synchronously scanning.
15. System/Light/Dark appearance actually changes the packaged Desktop and remains separate from Team Web theme settings.
16. Rough placement requires preview → confirmation with current Review revision; a stale confirmation is rejected without partial placement writes.
17. Material / Script uses the restored three-column workflow.

### Path audit after packaged smoke

Re-run the repository tracked/shared path leakage guard and inspect newly written project JSON/TOML artifacts. Device absolute paths are allowed only in explicitly device-local stores/responses.

## Phase D — Verification record

Update or create:

`docs/verification/2026-08-30-swift-golden-parity-full.md`

Record:

- exact validated commit SHA
- machine / OS
- `npm run typecheck`
- native `npm test` counts
- `npm run build`
- `check_python.py`
- `check_fast.py`
- `check_full.py`
- packaged staging / RC / Tauri build / bundle verification
- each packaged parity smoke item above as PASS / FAIL / NOT RUN
- any warning with ownership

Only actually executed success may be labelled PASS.

## Phase E — Source freeze / candidate commit

Once all non-FCP parity gates above pass:

1. Fix only gate-proven regressions.
2. Commit the fixes and verification record.
3. Re-run the entire A → C sequence on the final commit.
4. Push `feature/swift-golden-product-parity`.
5. Record the final feature SHA in `docs/engineering/STATUS.md`.

Do not yet merge `main` if the project still wants Final Cut Pro import smoke before integration.

## Explicitly out of scope for this closeout

### Native speech / dictation

Do not implement dictation in this parity closeout. Web Speech in embedded WKWebView is not a reliable production contract. Treat native/local STT as a separate device-runtime slice with microphone permissions, model lifecycle, durable preparation and packaged native smoke.

### Final Cut Pro

If Final Cut Pro is unavailable, keep authoritative FCPXML import smoke as `NOT RUN`. Do not simulate it and call it PASS.

### Release signing

Ad-hoc signing is not release signing. codesign/notarization remains separate unless credentials are available.

### No new scope

Do not start:

- Python package mass migration
- automatic music
- automatic editing
- Source Browser redesign
- new AI features
- Timeline feature expansion

until this parity candidate is executable-green.

## Final report format

Report exactly:

- final feature SHA
- Desktop typecheck result
- native Vitest result and counts
- Vite build result
- `check_python.py` result and counts
- `check_fast.py` result and counts
- `check_full.py` result and counts
- packaged build result
- packaged parity smoke result
- remaining `NOT RUN` items
- whether Swift Golden parity can be marked CLOSED
- whether integration to main is allowed
