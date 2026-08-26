# Codex — 镜序 macOS runtime audit / stabilization round 2

Target repository: `muee91/mirrororder`
Target branch: `fix/audit-p1-stabilization-20260825`
Target PR: `#9` (keep Draft; do not merge)

This is the second macOS verification pass. It incorporates defects found on the earlier `main@00b0413` run: Team Web first-paint freeze, Host-only API leakage into Team Web, stale test/build contracts, incomplete task controls, managed Host/Gateway lifecycle instability, portrait-media/native Slate validation gaps, and incomplete Slate → Script → Take convergence coverage.

The full packaging/native checklist remains in `docs/codex-macos-stabilization.md`. Run this round-2 document first, then continue with that document's runtime packaging and production smoke sections.

## 0. Protect existing local work

Do **not** hard-reset the operator's existing dirty checkout. The earlier Web freeze fix may still exist there as an uncommitted change. The stabilization branch now contains the official equivalent fix and regression test, so test it from a clean secondary worktree.

```bash
set -euo pipefail
cd /path/to/existing/mirrororder

git fetch origin --prune
BRANCH="fix/audit-p1-stabilization-20260825"
VERIFY_ROOT="../mirrororder-macos-round2"

if [ -e "$VERIFY_ROOT" ]; then
  echo "Refusing to overwrite existing $VERIFY_ROOT" >&2
  exit 1
fi

git worktree add --detach "$VERIFY_ROOT" "origin/$BRANCH"
cd "$VERIFY_ROOT"
SHA="$(git rev-parse HEAD)"
LOG_ROOT="$PWD/.codex-logs/$SHA-round2"
mkdir -p "$LOG_ROOT"

git status --short | tee "$LOG_ROOT/git-status.txt"
test -z "$(git status --porcelain)"
printf 'TEST_SHA=%s\n' "$SHA" | tee "$LOG_ROOT/environment.txt"
sw_vers | tee -a "$LOG_ROOT/environment.txt"
uname -m | tee -a "$LOG_ROOT/environment.txt"
```

Do not copy uncommitted files from the old checkout into this worktree before the baseline run.

## 1. Python targeted regression gates

Use Python 3.11+.

```bash
set -o pipefail
python3 --version | tee -a "$LOG_ROOT/environment.txt"
python3 -m pip install --upgrade pip pytest
python3 -m py_compile src/script_organizer/*.py tests/*.py \
  2>&1 | tee "$LOG_ROOT/python-compile.log"

python3 -m pytest -q \
  tests/test_web_material_card_runtime_safety.py \
  tests/test_frontend_bootstrap.py \
  tests/test_slate_script_take_convergence.py \
  tests/test_placement_drag_contract.py \
  tests/test_script_supervisor_and_assembly.py \
  tests/test_review_read_model.py \
  tests/test_native_script_supervisor_ui.py \
  tests/test_product_surface_contract.py \
  tests/test_desktop_layout_guard.py \
  tests/test_frontend_theme.py \
  tests/test_device_media.py \
  tests/test_timebase.py \
  tests/test_waveform_runtime.py \
  tests/test_delivery_fcpxml_keywords.py \
  tests/test_macos_runtime_packaging_contract.py \
  2>&1 | tee "$LOG_ROOT/python-targeted-round2.log"
```

### Full Python comparison against the old baseline

The earlier `main@00b0413` result was:

```text
294 passed, 39 failed
```

Run the full suite and report the **exact new passed/failed/skipped count**. Do not merely say "better" or "green".

```bash
python3 -m pytest -q 2>&1 | tee "$LOG_ROOT/python-full-round2.log"
```

If any failure still references deleted `macos-app/`, deleted `desktop-v2/`, or assumes project-sized Web modules are statically loaded instead of via `startup_release.js`, treat it as a stale contract defect and repair the test without weakening the behavioral assertion.

## 2. Desktop / TypeScript regression gates

```bash
cd desktop
node --version | tee -a "$LOG_ROOT/environment.txt"
npm --version | tee -a "$LOG_ROOT/environment.txt"
npm install --no-audit --no-fund 2>&1 | tee "$LOG_ROOT/npm-install-round2.log"

npm run check:baseline 2>&1 | tee "$LOG_ROOT/desktop-baseline-round2.log"
npm run typecheck 2>&1 | tee "$LOG_ROOT/desktop-typecheck-round2.log"

npx vitest run \
  src/api/tasks.test.ts \
  src/api/team.test.ts \
  src/api/mediaBindingConfirmation.test.ts \
  src/features/editor/timelineSeed.test.ts \
  src/features/material-script/episodeNavigation.test.ts \
  src/features/slate/slateKeyboard.test.ts \
  2>&1 | tee "$LOG_ROOT/desktop-targeted-round2.log"

npm test 2>&1 | tee "$LOG_ROOT/desktop-full-round2.log"
npm run build 2>&1 | tee "$LOG_ROOT/desktop-build-round2.log"
```

Compare the Vitest total with the previous known source run (62 tests at that time). The count may legitimately increase because regression tests were added; report the actual number.

## 3. Rust managed-service lifecycle gates

The new native contract is stronger than TCP-open readiness: `/api/v1/ping` must return the expected service identity (`mirrororder-host` or `mirrororder-gateway`) and `status=ok`.

```bash
rustc --version | tee -a "$LOG_ROOT/environment.txt"
cargo --version | tee -a "$LOG_ROOT/environment.txt"

cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml \
  2>&1 | tee "$LOG_ROOT/timeline-rust-round2.log"

cargo test --manifest-path src-tauri/Cargo.toml \
  2>&1 | tee "$LOG_ROOT/tauri-rust-round2.log"

cargo check --manifest-path src-tauri/Cargo.toml \
  2>&1 | tee "$LOG_ROOT/tauri-rust-check-round2.log"

npm run verify:rc 2>&1 | tee "$LOG_ROOT/local-rc-round2.log"
cd ..
```

Do not weaken the service identity check back to `TcpStream::connect` only.

## 4. Team Web browser/runtime regression

Use the same disposable project/workspace that previously reproduced the freeze if available. Do not edit production data directly.

Verify all of the following:

1. First paint completes; browser DOM inspection and screenshot do not hang.
2. After initial render settles, `material_card_ui.js` does not drive a self-triggering MutationObserver loop / sustained 100% browser CPU.
3. Material cards display Script Supervisor shot type through the `review.v1` projection.
4. The Network panel contains **no** request to `/api/v1/projects/<id>/script-supervisor` or any workspace equivalent merely for card decoration.
5. Team Web does not receive the old 403 caused by that Host-only endpoint.
6. Direct episode buttons are usable.
7. Click **全部** and confirm the known project still exposes 1343 script nodes (if the same dataset is used). Record the actual count instead of hard-coding a PASS if the dataset changed.
8. Default `first` remains intentional first-paint policy; do not change it to `all` just to satisfy this smoke. `全部` must remain one-click reachable.

Save browser console/network evidence under `$LOG_ROOT`. If using an automation/browser tool, save a screenshot after first paint and after switching to 全部.

## 5. Packaged Host / Gateway lifecycle stress

This must be performed on the current `desktop/` Tauri `.app`, not by manually launching the Python CLI and calling that equivalent.

After completing runtime staging and macOS build from `docs/codex-macos-stabilization.md`:

### Production Host — fixed port 8765

Repeat at least 5 cycles:

1. open/select the same disposable Workspace;
2. start Host on 8765;
3. verify `GET http://127.0.0.1:8765/api/v1/ping` returns `service=mirrororder-host`, `status=ok`;
4. stop Host from the App;
5. confirm 8765 is released;
6. start again on 8765.

Then simulate stale-child failure once:

1. start Host normally;
2. identify the managed Python Host PID without killing the Tauri App;
3. terminate that child;
4. ask the App to start/connect the same Workspace again;
5. verify it recovers on **8765**, not 8767/8768;
6. verify the new ping identity before declaring recovery PASS.

### Team Gateway — fixed port 8766

Repeat at least 5 start/stop cycles and verify `service=mirrororder-gateway` on `/api/v1/ping` every time.

Also exercise the new unhealthy state if practical: make the managed service disappear while the App stays alive, refresh Team Web status, confirm the UI reports `unhealthy`, and use **重启 Gateway**. Recovery must reuse 8766.

A random open TCP listener on 8765/8766 must **not** be accepted as a healthy MirrorOrder service. If safe, bind a temporary local HTTP server that returns the wrong `service` value and verify MirrorOrder rejects it.

Do not use 8767 as a workaround in the final result.

## 6. Collaboration URL boundary

For LAN mode:

- the link shown/copied by the App must use a non-loopback address such as `http://192.168.x.x:8766/`;
- it must never silently substitute `127.0.0.1` when LAN discovery fails;
- if no LAN address is available, the UI should present no share URL instead of a fake collaborator URL;
- localhost is valid only when **仅本机** mode was explicitly selected.

If a phone/iPad/second computer is available, open the generated link there and complete pairing + reviewer refresh. With only one Mac and no second client, report the cross-device part as `BLOCKED_NO_SECOND_DEVICE`, not PASS.

## 7. Task controls

Use only a disposable project/task. Do not cancel a production job the operator cares about.

Verify in Desktop Settings/Status:

- queued task: **取消** immediately transitions to `cancelled`;
- running task: **取消任务** sets cancellation requested and stops at the next backend cancellation point;
- failed/cancelled/interrupted task: **重试** creates/reuses the durable retry according to TaskManager idempotency semantics;
- completed task does not expose a retry button merely to create duplicates;
- the panel updates active progress and cancellation status without requiring an App restart.

The backend currently has no user-facing task-priority/reordering contract. Do not invent or add a drag-to-reorder queue UI during this validation.

If there is no safe task type that can be created without real project work, mark the interactive task mutation subsection `BLOCKED_NO_SAFE_FIXTURE` after the unit/API tests pass.

## 8. Slate → Script → Take convergence

Use a disposable copy of the real project that previously showed roughly 668 groups / 1502 media rows, if still available. Record actual counts because project data may have changed.

Verify both directions of **visibility**, while preserving authority boundaries:

### Review/Script placement → Slate

1. choose a Take with an existing automatic/high-confidence script mapping;
2. manually place it onto another valid script segment;
3. verify `review.json` effective mapping becomes human/manual;
4. verify Script Supervisor projection shows the corresponding episode/scene and the same Take attachments;
5. verify Web/Desktop review model immediately resolves to the human mapping rather than the stale automatic mapping.

### Slate production evidence → review surfaces

1. edit a Take's shot type/note in Script Supervisor;
2. verify the same shot type/note is visible where Review material cards/read models project Script Supervisor evidence;
3. confirm this does **not** silently mutate editorial Review mapping authority.

Ordering contract:

- episode number sorts first;
- within the same episode: manual > exact/high-confidence script > possible script > episode-only > XML fallback;
- XML timeline order is the final fallback, not allowed to outrank high-confidence script evidence in the same episode.

Any discrepancy is a functional failure, not a screenshot-only issue.

## 9. Native-only macOS validations still required

Continue the production smoke from `docs/codex-macos-stabilization.md`, with these explicit additions from the prior run:

### Portrait video

Use a real vertical clip (for example 1080x1920). Verify player sizing follows `presentationSize` and does not render an incorrect horizontal presentation/black-bar layout. Record clip dimensions and a screenshot.

### Slate drag / inspector layout

In the packaged App, physically drag the Script Supervisor region vertically through its supported range and verify it remains usable after resize. Confirm the right inspector no longer consumes disproportionate width. This is `DEVICE_REQUIRED_MACOS`; source CSS/React tests alone are insufficient.

### Finder / Final Cut integration

Exercise the current `desktop/` Tauri path only. Do **not** run the deleted `macos-app/build_app.sh` command. Verify current Finder/path actions and Final Cut FCPXML open/import behavior from the packaged App.

Then complete real-media playback, >=60-minute waveform, multicam, Timeline checkpoint/recovery, FCPXML decision delivery, codesign/notarization status, as specified in the main macOS stabilization document.

## 10. Repair rules

When a gate fails because of a genuine repo defect:

1. reproduce it from the clean worktree;
2. fix it on `fix/audit-p1-stabilization-20260825` (not `main`);
3. add or strengthen a regression test;
4. commit the fix;
5. fetch/rebase only if needed; never overwrite unrelated operator work;
6. rerun the smallest failing gate, then its containing full gate;
7. report the new tested SHA.

Never use `skip`, `xfail`, disabled UI, deleted assertions, arbitrary larger timeouts, or port drift as a substitute for fixing a reproducible defect.

## 11. Required result format

```text
TEST_SHA: <exact final tested SHA>
MACOS: <version>
ARCH: arm64|x86_64
FINAL_CUT: <version or unavailable>

OLD_PYTHON_BASELINE: 294 passed, 39 failed
NEW_PYTHON_RESULT: <exact pytest summary>
NEW_VITEST_RESULT: <exact vitest summary>

PYTHON_COMPILE: PASS|FAIL
PYTHON_TARGETED_ROUND2: PASS|FAIL
PYTHON_FULL: PASS|FAIL
DESKTOP_BASELINE: PASS|FAIL
DESKTOP_TYPECHECK: PASS|FAIL
DESKTOP_TARGETED_ROUND2: PASS|FAIL
DESKTOP_FULL: PASS|FAIL
DESKTOP_BUILD: PASS|FAIL
TIMELINE_RUST: PASS|FAIL
TAURI_RUST_TEST: PASS|FAIL
TAURI_RUST_CHECK: PASS|FAIL
LOCAL_RC: PASS|FAIL

WEB_FIRST_PAINT: PASS|FAIL|BLOCKED
WEB_NO_MUTATION_LOOP: PASS|FAIL|BLOCKED
TEAM_WEB_NO_HOST_ONLY_REQUEST: PASS|FAIL|BLOCKED
EPISODE_ALL: PASS|FAIL|BLOCKED
HOST_8765_LIFECYCLE: PASS|FAIL|BLOCKED
GATEWAY_8766_LIFECYCLE: PASS|FAIL|BLOCKED
WRONG_SERVICE_PORT_REJECTION: PASS|FAIL|BLOCKED
LAN_SHARE_URL: PASS|FAIL|BLOCKED
TASK_CANCEL_RETRY: PASS|FAIL|BLOCKED_NO_SAFE_FIXTURE
SLATE_SCRIPT_TAKE_CONVERGENCE: PASS|FAIL|BLOCKED
PORTRAIT_MEDIA: PASS|FAIL|BLOCKED
SLATE_DRAG_LAYOUT: PASS|FAIL|BLOCKED

RUNTIME_STAGE: PASS|FAIL|BLOCKED
MACOS_TAURI_BUILD: PASS|FAIL|BLOCKED
MACOS_BUNDLE_GATE: PASS|FAIL|BLOCKED
PACKAGED_HOST_SMOKE: PASS|FAIL|BLOCKED
REAL_MEDIA_PLAYBACK: PASS|FAIL|BLOCKED
WAVEFORM_LONG_MEDIA: PASS|FAIL|BLOCKED
MULTICAM_REAL_MEDIA: PASS|FAIL|BLOCKED
TIMELINE_RECOVERY: PASS|FAIL|BLOCKED
FCPXML_FINAL_CUT: PASS|FAIL|BLOCKED
TEAM_GATEWAY_CROSS_DEVICE: PASS|FAIL|BLOCKED_NO_SECOND_DEVICE
CODESIGN: PASS|FAIL|NOT_RUN
NOTARIZATION: PASS|FAIL|NOT_RUN

FIRST_CAUSAL_FAILURE:
<exact command/action + root cause>

FIXES_COMMITTED_BY_CODEX:
<none or commit SHA, files, regression tests>

UNRESOLVED_DEVICE_GATES:
<list>

LOG_ROOT:
<absolute path>
```

Do not promote PR #9 from Draft solely because source tests are green. The macOS milestone requires the packaged App lifecycle, real media, Timeline recovery, multicam and Final Cut path to be actually exercised.
