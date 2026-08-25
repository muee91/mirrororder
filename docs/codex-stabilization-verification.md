# Codex verification runbook — audit P1 stabilization

Target branch: `fix/audit-p1-stabilization-20260825`
Target PR: `#9`

This runbook exists for verification steps that cannot be completed from the audit session because a real checkout, OS runner, FFmpeg, Tauri toolchain, or native application is required.

## Rules

- Do not modify production behavior merely to make a test pass.
- Do not skip, xfail, or weaken failing assertions unless the assertion is demonstrably stale and the replacement preserves or strengthens the intended contract.
- Record the exact commit SHA tested.
- Run targeted regressions first, then the full suite.
- If a command fails, save the complete stdout/stderr and identify the first causal failure rather than only the final cascade.
- Do not report a suite as passing unless the command actually exited with status 0.
- Native macOS/Windows smoke results must name the OS version, architecture, Python/Node/Rust versions, and whether FFmpeg/ffprobe were available.

## 1. Pull the exact branch

### Bash / zsh

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
printf 'TEST_SHA=%s\n' "$(git rev-parse HEAD)"
```

### PowerShell

```powershell
$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/muee91/mirrororder.git"
$Branch = "fix/audit-p1-stabilization-20260825"

if (-not (Test-Path "mirrororder/.git")) {
  git clone $RepoUrl mirrororder
}
Set-Location mirrororder
git fetch origin --prune
git switch $Branch 2>$null
if ($LASTEXITCODE -ne 0) { git switch -c $Branch --track "origin/$Branch" }
git reset --hard "origin/$Branch"
git clean -ffd
Write-Host "TEST_SHA=$(git rev-parse HEAD)"
```

## 2. Python verification

The repository CI uses Python 3.11 and installs only `pytest` for the standard Python job.

```bash
python --version
python -m pip install --upgrade pip pytest
python -m py_compile src/script_organizer/*.py tests/*.py

# Audit-stabilization regressions first
python -m pytest -q \
  tests/test_asr_data_root.py \
  tests/test_device_media.py \
  tests/test_timebase.py \
  tests/test_waveform_runtime.py \
  tests/test_delivery_fcpxml_keywords.py \
  tests/test_product_surface_contract.py \
  tests/test_desktop_layout_guard.py \
  tests/test_frontend_theme.py \
  tests/test_native_script_supervisor_ui.py

# Then full Python regression
python -m pytest -q
```

If optional runtime tests require project extras, install only the dependency needed by the failing test and record that dependency separately. Do not silently broaden the environment before the standard suite is attempted.

## 3. Desktop / TypeScript / Vitest verification

Use Node 22, matching CI.

```bash
cd desktop
node --version
npm --version
npm install --no-audit --no-fund
npm run check:baseline
npm run typecheck

# Targeted regressions added/changed by PR #9
npx vitest run \
  src/api/mediaBindingConfirmation.test.ts \
  src/features/editor/timelineSeed.test.ts \
  src/features/material-script/episodeNavigation.test.ts \
  src/features/slate/slateKeyboard.test.ts

# Full Desktop tests and frontend build
npm test
npm run build
cd ..
```

Do not replace `npm install` with a different dependency resolution strategy unless the repository lockfile requires it; if a lockfile mismatch is found, report it explicitly.

## 4. Rust Timeline + Tauri Host verification

```bash
rustc --version
cargo --version
cargo test --manifest-path desktop/src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cargo check --manifest-path desktop/src-tauri/Cargo.toml
```

On Linux, install the same native dependencies as CI before Tauri checks:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

## 5. FFmpeg / waveform smoke

Required on a machine with `ffmpeg` and `ffprobe` available.

```bash
ffmpeg -version | head -1
ffprobe -version | head -1
which ffmpeg || where ffmpeg
which ffprobe || where ffprobe
```

Exercise at least:

1. A short clip (< 60 s).
2. A long clip (>= 60 min preferred).
3. A clip with no audio stream.
4. A missing/offline media path.

Confirm waveform generation is bounded, returns the requested peak count contract, and does not time out solely because the source is long.

## 6. Windows multicam gate

Run on Windows without Administrator elevation first. This gate is specifically intended to detect hidden symlink privilege assumptions.

Record:

```powershell
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsArchitecture
python --version
node --version
rustc --version
ffmpeg -version | Select-Object -First 1
ffprobe -version | Select-Object -First 1
```

Test these layouts:

1. One root containing `A/B/C` camera directories.
2. One root containing shooting-day directories, each containing cameras.
3. Multiple roots on the same drive.
4. Multiple roots on different drive letters.
5. Non-ASCII + spaces in paths.

Acceptance conditions:

- No Administrator-only symlink requirement for the normal supported path.
- No media bytes are duplicated merely to build the normalized sync view.
- If a safe link/junction cannot be created, the operation fails closed with an actionable message.
- Generated FCPXML resolves media relative to the delivery XML correctly.
- The analysis path must not make relative media URLs resolve against the wrong directory.

## 7. macOS FCPXML gate

Run on a Mac with Final Cut Pro installed and real media.

For an FCPXML project containing an explicit human Best/Keep/Reject decision:

1. Export `organized.fcpxml`.
2. Confirm source `resources`, multicam resources, project sequence, spine structure and source media are not destructively rewritten.
3. Confirm MirrorOrder decision keywords are present only where the source asset/range can be resolved safely.
4. Import the generated FCPXML into Final Cut Pro.
5. Verify the browser keywords point at the expected media ranges.
6. Verify a deliberately unmappable decision makes export fail closed rather than producing a partial decision export.

Record Final Cut Pro version and the exact input/output file hashes.

## 8. Desktop native smoke — macOS and Windows

Exercise the following on both platforms where applicable:

- launch Desktop from a clean state;
- select/open a workspace;
- reconnect/restart the local service;
- scan local media;
- observe a filename-only provisional media candidate and explicitly confirm it;
- verify a replaced file at the same path is rejected when content identity no longer matches;
- navigate a project with more than 32 episodes;
- use Slate keyboard flow (`Option+Up/Down`, `Cmd/Ctrl+Enter`);
- build a rough-cut Timeline using the project-declared rational timebase;
- close/reopen the app and verify Timeline persistence/recovery;
- run delivery export.

Do not mark macOS/Windows release gates green from browser preview alone.

## 9. Required Codex result format

Return one report with this structure:

```text
TEST_SHA: <40-char sha>
OS: <name/version/arch>

PYTHON_COMPILE: PASS|FAIL|BLOCKED
PYTHON_TARGETED: PASS|FAIL|BLOCKED
PYTHON_FULL: PASS|FAIL|BLOCKED
DESKTOP_BASELINE: PASS|FAIL|BLOCKED
DESKTOP_TYPECHECK: PASS|FAIL|BLOCKED
DESKTOP_TARGETED: PASS|FAIL|BLOCKED
DESKTOP_FULL: PASS|FAIL|BLOCKED
DESKTOP_BUILD: PASS|FAIL|BLOCKED
TIMELINE_RUST: PASS|FAIL|BLOCKED
TAURI_RUST_TEST: PASS|FAIL|BLOCKED
TAURI_RUST_CHECK: PASS|FAIL|BLOCKED
FFMPEG_WAVEFORM_SMOKE: PASS|FAIL|BLOCKED
WINDOWS_MULTICAM_SMOKE: PASS|FAIL|BLOCKED|N/A
MACOS_FCPXML_SMOKE: PASS|FAIL|BLOCKED|N/A
DESKTOP_NATIVE_SMOKE: PASS|FAIL|BLOCKED

FIRST_CAUSAL_FAILURE:
<command + concise root cause>

CHANGED_FILES_BY_CODEX:
<none, or exact paths and why>

FULL_LOG_PATHS:
<paths to saved logs>
```

If Codex fixes a genuine defect while testing, it must add/strengthen a regression test, commit the change to the same stabilization branch, and report the new SHA. It must not merge PR #9 or mark it ready for review by itself.
