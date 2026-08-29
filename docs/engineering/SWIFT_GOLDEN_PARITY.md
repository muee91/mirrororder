# Swift Golden Product Parity Contract

Status: **source recovery candidate; executable gates NOT RUN**  
Branch: `feature/swift-golden-product-parity`  
Baseline: `feature/timeline-audio-ux` @ `20d0febdd226d551628f9f11b4285d9b6efacdd6`

This document defines which product-level behaviors from the Swift Golden prototype must remain visible and usable in the current Tauri/React Desktop without weakening the current Python/Rust authority model.

## Authority boundary

Restoring product parity does **not** restore Swift as a second authority.

- Python MirrorOrder Core remains authoritative for Workspace/Project lifecycle, Review, Slate/Script Supervisor, media identity/binding, Identity, Assistant proposals and delivery semantics.
- Rust Timeline Core remains authoritative for local Timeline editing, undo/redo, persistence authority and timeline-derived delivery state.
- React/Tauri is the product surface and device integration layer only.
- AI remains `evidence → proposal → human confirmation → authority`.
- Device-local absolute paths may appear only in explicit local responses/actions and must never be persisted into shared project artifacts.

## Required Desktop product parity

### 1. Project Home first

After a workspace opens or resumes, Desktop lands on Project Home rather than auto-opening the previously selected project.

Required behaviors:

- Project card grid.
- Recent projects in the global sidebar.
- Explicit project open.
- Persistent per-project canvas history may remain device-local, but it must not bypass Project Home on workspace startup.

### 2. Golden multi-camera Slate

The primary Slate surface is a production table, not a read-only Review summary.

Required behaviors:

- Separate A / B / C / Auxiliary-Special media columns.
- Direct Episode / Scene / Shot / Take editing.
- Independent blank Slate records that do not require an existing Review Take.
- `从 Take 加入`, `同场下一条`, `同上`, `空白` production flows.
- Sequential human save and dirty-row feedback.
- Right-side Inspector.
- Per-angle camera, shot type and attachment note editing.
- Human I/O usable range.
- `preferred_clip_id` as Slate preferred angle, explicitly distinct from Editorial Best.
- Finder/Explorer drag-in may resolve device-local media identity only during the explicit drop action; the saved Slate record remains path-free.
- Space/J/K/L transport keys: Space play/pause, J one-second backward shuttle step, K pause, L forward play. J must not pretend browser video supports reliable reverse playback.

### 3. One MirrorOrder Media Card

Slate, Take lists and Take Inspector share one visual media-card contract.

The card must retain:

- camera label
- display name
- shot type
- role/coverage metadata where available
- duration
- selected state
- missing/unavailable state
- duplicate count where relevant
- Slate preferred-angle star where relevant

`AngleEvidenceCard` may remain as an internal adapter name, but it must not own a second card renderer.

### 4. Review placement remains auxiliary

Review placement/exclusion is not the Slate authority.

Required auxiliary pools:

- pending
- placed
- excluded
- orphan media
- script/scene placement targets

The old Slate workbench must not reintroduce a second production Slate table. Review placement may be exposed as a helper panel under Golden Slate.

### 5. Material / Script three-column workbench

The production layout must preserve the high-value Golden spatial model:

- left: rough placement or precise script target
- center: Take/media pool
- right: Take Inspector

Rough placement is a proposal/preview followed by explicit human confirmation. Confirmed batch writes require the current Review revision; stale previews must return conflict and perform zero writes.

### 6. Project-level context actions

Project rows expose explicit high-value actions without introducing new state authority:

- Team Review
- Finder / Explorer reveal
- Local Media / replace media drive
- Re-prepare project

Finder/Explorer reveal uses a local-only project-location endpoint. Re-prepare submits the existing durable `prepare_project` task and opens Status Center; it never performs synchronous scan/analysis in the click handler.

### 7. Desktop Appearance is separate from Team Web

Desktop owns a device-local appearance preference:

- System
- Light
- Dark

The preference is stored only in Desktop local storage and applied to the Desktop DOM. It must not reuse or mutate Team Web `FrontendSettings.theme` or project/workspace artifacts.

System mode keeps existing `prefers-color-scheme` behavior. Explicit Light/Dark root-prefixed overrides load after feature CSS so the user choice wins over the operating-system media query.

## Read-path and path-safety requirements

The parity work must continue to obey the production read-path contract:

- no scan/hash/FFmpeg/model load/index rebuild/network inference in GET routes
- project-location GET reads only the registered project config needed for an explicit local reveal action
- Slate file-drop media hashing/identity happens only in explicit POST/drop handling, never GET
- no absolute device paths are persisted into Slate, Review, Timeline, Delivery or other shared artifacts

## Explicit non-goals

The parity branch does not:

- replace Rust Timeline authority
- replace Python Review/Slate authority
- reintroduce legacy product routes only for compatibility
- auto-promote Review opinions to Editorial decisions
- auto-insert non-Best media into Timeline
- treat media availability as editorial selection
- fake reverse video playback

## Still unresolved before parity can be called complete

### Native speech/dictation

The Swift prototype exposed speech-oriented Slate capture. The Tauri branch must not claim this is restored until a reliable current native/WebView speech path is verified and covered by product tests. A text capture field remains available in the meantime.

### Executable validation

Source/diff review is not an executable PASS. Before integration, run on a complete checkout:

1. Python source gate (`scripts/check_python.py`)
2. fast gate (`scripts/check_fast.py`)
3. full gate (`scripts/check_full.py`)
4. TypeScript typecheck and Vitest
5. Rust Timeline/Tauri tests and cargo check
6. packaged Desktop/native media smoke
7. FCPXML/delivery smoke where applicable

Until those gates actually run successfully, the parity branch remains an isolated source candidate and must not be merged to `main` as a verified release.
