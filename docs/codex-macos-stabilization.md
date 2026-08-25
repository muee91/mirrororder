# Codex — 镜序 macOS-first stabilization / verification

Target branch: `fix/audit-p1-stabilization-20260825`
Target PR: `#9`

The operator currently has macOS only. Treat Windows gates as deferred, not as blockers for the macOS milestone.

## Operating rules

- Pull and test the exact remote branch; print the tested SHA.
- Do not merge PR #9.
- Do not weaken/skip tests to get green output.
- A test is PASS only when its command exits 0.
- Save complete logs under `.codex-logs/<SHA>/`.
- If a genuine defect is found, fix it on the same branch, add/strengthen a regression test, commit it, rerun the affected gate and report the new SHA.
- Do not commit portable Python, FFmpeg, model weights, build output, `.app`, or DMG binaries.
- For release payloads, do not use Homebrew Python/FFmpeg as the packaged runtime. Development tools may come from Homebrew, but the `.app` must be self-contained.

## 1. Pull the stabilization branch

```bash
set -euo pipefail
REPO_URL="https://github.com/muee91/mirrororder.git"
BRANCH="fix/audit-p1-stabilization-20260825"

if [ ! -d mirrororder/.git ]; then
  git clone "$REPO_URL" mirrororder
fi
cd mirrororder
git fetch origin --prune
git switch "$BRANCH" 2>/dev/null || git switch -c "$BRANCH" --track "origin/$BRANCH"
git reset --hard "origin/$BRANCH"
git clean -ffd
SHA="$(git rev-parse HEAD)"
LOG_ROOT="$PWD/.codex-logs/$SHA"
mkdir -p "$LOG_ROOT"
printf 'TEST_SHA=%s\n' "$SHA" | tee "$LOG_ROOT/environment.txt"
sw_vers | tee -a "$LOG_ROOT/environment.txt"
uname -m | tee -a "$LOG_ROOT/environment.txt"
```

## 2. Source-level gates first

Use Python 3.11+ for the source tests, Node 22 and stable Rust.

```bash
set -o pipefail
python3 --version | tee -a "$LOG_ROOT/environment.txt"
node --version | tee -a "$LOG_ROOT/environment.txt"
npm --version | tee -a "$LOG_ROOT/environment.txt"
rustc --version | tee -a "$LOG_ROOT/environment.txt"
cargo --version | tee -a "$LOG_ROOT/environment.txt"

python3 -m pip install --upgrade pip pytest
python3 -m py_compile src/script_organizer/*.py tests/*.py 2>&1 | tee "$LOG_ROOT/python-compile.log"

python3 -m pytest -q \
  tests/test_asr_data_root.py \
  tests/test_device_media.py \
  tests/test_timebase.py \
  tests/test_waveform_runtime.py \
  tests/test_delivery_fcpxml_keywords.py \
  tests/test_macos_runtime_packaging_contract.py \
  tests/test_product_surface_contract.py \
  tests/test_desktop_layout_guard.py \
  tests/test_frontend_theme.py \
  tests/test_native_script_supervisor_ui.py \
  2>&1 | tee "$LOG_ROOT/python-targeted.log"

python3 -m pytest -q 2>&1 | tee "$LOG_ROOT/python-full.log"

cd desktop
npm install --no-audit --no-fund 2>&1 | tee "$LOG_ROOT/npm-install.log"
npm run check:baseline 2>&1 | tee "$LOG_ROOT/desktop-baseline.log"
npm run typecheck 2>&1 | tee "$LOG_ROOT/desktop-typecheck.log"
npx vitest run \
  src/api/mediaBindingConfirmation.test.ts \
  src/features/editor/timelineSeed.test.ts \
  src/features/material-script/episodeNavigation.test.ts \
  src/features/slate/slateKeyboard.test.ts \
  2>&1 | tee "$LOG_ROOT/desktop-targeted.log"
npm test 2>&1 | tee "$LOG_ROOT/desktop-full.log"
npm run build 2>&1 | tee "$LOG_ROOT/desktop-build.log"

cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml 2>&1 | tee "$LOG_ROOT/timeline-rust.log"
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tee "$LOG_ROOT/tauri-rust-test.log"
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tee "$LOG_ROOT/tauri-rust-check.log"
cd ..
```

Also run the repository aggregate gate after individual failures are understood:

```bash
cd desktop
npm run verify:rc 2>&1 | tee "$LOG_ROOT/local-rc.log"
cd ..
```

## 3. Prepare release runtime inputs

The build now requires two explicit self-contained inputs:

```text
MIRRORORDER_PORTABLE_PYTHON_ROOT
MIRRORORDER_MEDIA_TOOLS_ROOT
```

### Portable Python

Use a relocatable CPython 3.11+ distribution matching the Mac architecture. `astral-sh/python-build-standalone` `install_only` distributions are an appropriate source. Prefer native architecture:

```bash
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  PY_TARGET="aarch64-apple-darwin" ;;
  x86_64) PY_TARGET="x86_64-apple-darwin" ;;
  *) echo "unsupported mac architecture: $ARCH" >&2; exit 1 ;;
esac
```

Codex may query the current `python-build-standalone` latest-release metadata, select a CPython 3.11/3.12 `*-install_only.tar.gz` asset for `$PY_TARGET`, verify its published SHA-256, extract it under an ignored build-input directory, then install the hard Python modules into that runtime itself:

```bash
RUNTIME_INPUTS="$PWD/.runtime-inputs/macos-$(uname -m)"
PY_ROOT="$RUNTIME_INPUTS/python"
# After extracting the selected install_only archive so PY_ROOT/bin/python3 exists:
"$PY_ROOT/bin/python3" -m ensurepip --upgrade || true
"$PY_ROOT/bin/python3" -m pip install --upgrade pip
"$PY_ROOT/bin/python3" -m pip install numpy pandas scipy
"$PY_ROOT/bin/python3" -I -c 'import sys,numpy,pandas,scipy; print(sys.version); print(sys.executable); print(sys.prefix)'
```

Do not use a normal `venv` whose interpreter/prefix resolves outside `$PY_ROOT`; `stage:runtime` intentionally rejects external symlinks and non-relocatable prefixes.

### FFmpeg / FFprobe

Provide self-contained native macOS `ffmpeg` and `ffprobe` under:

```text
$TOOLS_ROOT/bin/ffmpeg
$TOOLS_ROOT/bin/ffprobe
```

Set:

```bash
TOOLS_ROOT="$RUNTIME_INPUTS/media-tools"
chmod +x "$TOOLS_ROOT/bin/ffmpeg" "$TOOLS_ROOT/bin/ffprobe"
"$TOOLS_ROOT/bin/ffmpeg" -version | head -1
"$TOOLS_ROOT/bin/ffprobe" -version | head -1
```

For Apple Silicon, prefer native arm64 binaries. Do not choose an Intel-only package as the default release payload merely because Rosetta can run it. Record binary source/version/license in the verification report.

Before packaging, inspect dependencies:

```bash
otool -L "$TOOLS_ROOT/bin/ffmpeg"
otool -L "$TOOLS_ROOT/bin/ffprobe"
```

A release payload must not depend on build-machine paths such as Homebrew Cellar prefixes.

## 4. Stage the runtime

```bash
export MIRRORORDER_PORTABLE_PYTHON_ROOT="$PY_ROOT"
export MIRRORORDER_MEDIA_TOOLS_ROOT="$TOOLS_ROOT"

cd desktop
npm run stage:runtime 2>&1 | tee "$LOG_ROOT/runtime-stage.log"
cd ..
```

Expected generated resources (ignored by git):

```text
desktop/src-tauri/resources/
├── mirrororder-core/
├── mirrororder-python/
├── mirrororder-tools/
└── mirrororder-runtime/mirrororder-runtime-manifest.json
```

Confirm the working tree contains no staged runtime binaries:

```bash
git status --short
```

## 5. Build the macOS app

Tauri automatically merges `tauri.macos.conf.json` on macOS.

```bash
cd desktop
export MIRRORORDER_PORTABLE_PYTHON_ROOT="$PY_ROOT"
export MIRRORORDER_MEDIA_TOOLS_ROOT="$TOOLS_ROOT"
npm run tauri -- build --bundles app,dmg 2>&1 | tee "$LOG_ROOT/tauri-macos-build.log"
npm run verify:macos-bundle 2>&1 | tee "$LOG_ROOT/macos-bundle-gate.log"
cd ..
```

The bundle verifier must prove:

- `mirrororder_packaged_runtime.v1` manifest exists;
- bundled Python imports `script_organizer.cli`, `numpy`, `pandas`, `scipy` under `-I`;
- bundled FFmpeg/FFprobe execute;
- inspected Mach-O files do not reference build-machine dylib paths;
- Core and first-party multicam engine are present.

For a signed candidate:

```bash
cd desktop
MIRRORORDER_REQUIRE_CODESIGN=1 npm run verify:macos-bundle 2>&1 | tee "$LOG_ROOT/macos-codesign-gate.log"
cd ..
```

Do not mark notarization PASS merely from `codesign --verify`; notarization/stapling is a separate release gate.

## 6. Simulate a clean Mac runtime

Locate the built app:

```bash
APP="$(find desktop/src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit)"
test -n "$APP"
echo "$APP" | tee "$LOG_ROOT/app-path.txt"
```

Launch without Homebrew/global developer PATH:

```bash
env -i \
  HOME="$HOME" \
  USER="$USER" \
  LOGNAME="$LOGNAME" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  TMPDIR="${TMPDIR:-/tmp}" \
  "$APP/Contents/MacOS/镜序" \
  >"$LOG_ROOT/packaged-app.stdout.log" \
  2>"$LOG_ROOT/packaged-app.stderr.log" &
APP_PID=$!
echo "$APP_PID" > "$LOG_ROOT/packaged-app.pid"
```

Acceptance: opening a workspace must start the Host using bundled runtime resources. Do not set `MIRRORORDER_CORE_ROOT`, `MIRRORORDER_PYTHON`, or a Homebrew PATH for this smoke.

## 7. macOS production smoke

Use a disposable copy of a real project/workspace. Record every input path and source hash where practical.

### Host / project

- launch packaged app;
- select workspace;
- verify project list and project open/refresh;
- stop/restart Host once;
- close/reopen app and verify workspace/project state survives.

### Media identity

- scan real media;
- test a filename-only provisional candidate: it must require explicit confirmation;
- confirm candidate and verify resolution;
- replace the file at the same path with different bytes and verify content identity rejects it;
- restore the real file and rebind explicitly.

### 100-episode navigation

Use/generate a 100+ episode script fixture and verify episodes beyond 32 are visible, searchable and valid drop targets.

### Slate keyboard flow

Verify:

- `Option+Up` / `Option+Down` switches Takes;
- `Cmd+Enter` parses, then confirms;
- successful write advances to the next Take and restores note-entry focus.

### Waveform / playback

Use at least:

- short clip;
- >=60 minute clip;
- no-audio clip;
- offline/missing clip.

Verify long media does not fail solely because the old fixed 60-second full-decode timeout was exceeded.

### Multicam

Run at least one real A/B/C sync. Verify generated `synchronized.fcpxml` validates and resolves media paths from its actual delivery location. Record duration and failure logs.

### Timeline

Use an FCPXML project with a non-integer timebase if available (23.976 = 24000/1001 is preferred). Verify rough-cut proposal carries rational timebase, apply it, checkpoint, quit the app, reopen and recover the same Timeline.

### Final Cut Pro

For a project with explicit human Best/Keep/Reject decisions:

1. export `organized.fcpxml`;
2. verify source resources/multicam/project/sequence/spine are not destructively rewritten;
3. verify MirrorOrder decision keywords occur only on safely resolved source ranges;
4. import/open the generated file in Final Cut Pro;
5. verify keyword ranges point to the expected media;
6. create one deliberately unmappable decision and confirm export fails closed instead of writing a partial decision export.

Record:

```bash
shasum -a 256 <input.fcpxml> <organized.fcpxml>
```

and Final Cut Pro version.

### Team Gateway (macOS milestone, second device if available)

If a phone/iPad/second computer is available on the same LAN, verify pairing, reviewer write, refresh and reconnect. If no second device is available, report `BLOCKED_NO_SECOND_DEVICE`; do not fake a PASS with localhost only.

## 8. Result format Codex must return

```text
TEST_SHA: <sha>
MACOS: <version>
ARCH: arm64|x86_64
FINAL_CUT: <version or unavailable>

PYTHON_COMPILE: PASS|FAIL
PYTHON_TARGETED: PASS|FAIL
PYTHON_FULL: PASS|FAIL
DESKTOP_BASELINE: PASS|FAIL
DESKTOP_TYPECHECK: PASS|FAIL
DESKTOP_TARGETED: PASS|FAIL
DESKTOP_FULL: PASS|FAIL
DESKTOP_BUILD: PASS|FAIL
TIMELINE_RUST: PASS|FAIL
TAURI_RUST_TEST: PASS|FAIL
TAURI_RUST_CHECK: PASS|FAIL
LOCAL_RC: PASS|FAIL
RUNTIME_STAGE: PASS|FAIL|BLOCKED
MACOS_TAURI_BUILD: PASS|FAIL|BLOCKED
MACOS_BUNDLE_GATE: PASS|FAIL|BLOCKED
PACKAGED_HOST_SMOKE: PASS|FAIL|BLOCKED
REAL_MEDIA_PLAYBACK: PASS|FAIL|BLOCKED
WAVEFORM_LONG_MEDIA: PASS|FAIL|BLOCKED
MULTICAM_REAL_MEDIA: PASS|FAIL|BLOCKED
TIMELINE_RECOVERY: PASS|FAIL|BLOCKED
FCPXML_FINAL_CUT: PASS|FAIL|BLOCKED
TEAM_GATEWAY_LAN: PASS|FAIL|BLOCKED_NO_SECOND_DEVICE
CODESIGN: PASS|FAIL|NOT_RUN
NOTARIZATION: PASS|FAIL|NOT_RUN

PORTABLE_PYTHON_SOURCE_VERSION_SHA256:
<...>
FFMPEG_FFPROBE_SOURCE_VERSION_LICENSE:
<...>

FIRST_CAUSAL_FAILURE:
<command + root cause>

FIXES_COMMITTED_BY_CODEX:
<none or commit SHA + files + regression test>

LOG_ROOT:
<absolute path>
```

The macOS milestone is ready for merge only after source gates, packaged runtime/build, packaged Host, real media, multicam, Timeline recovery, and Final Cut import are all PASS. LAN may remain explicitly blocked only if no second device exists; signing/notarization can remain a later distribution gate for an internal development build, but not for a public release candidate.
