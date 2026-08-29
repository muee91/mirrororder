# Codex Handoff — Finish MirrorOrder Production Readiness

日期：2026-08-29  
目标：完成当前会话无法在远端 API 环境执行的最后本地工作，不重新设计架构。

## 0. Authority / scope

当前候选分支：

```text
feature/timeline-audio-ux
```

开始前：

```bash
git fetch origin
git switch feature/timeline-audio-ux
git pull --ff-only
```

确认 `docs/engineering/STATUS.md`、`INVARIANTS.md`、`DECISIONS.md`、`INTEGRATION_PLAN.md` 后再改代码。

硬规则：

- Python MirrorOrder Core：项目、Review、Slate、Identity、AI proposal、media binding、Delivery/FCPXML authority。
- Rust Timeline Core：本机 authoritative Timeline edit state。
- React/TS：UI / DTO / proposal，不创建第二套 Timeline authority。
- AI：`evidence -> proposal -> human confirmation -> authority`。
- 不恢复旧 `/api/v1/local-runtime`。
- 不增加 legacy route / compatibility bridge，除非现有真实 consumer 能证明需要。
- GET / 页面打开 / Inspector 不得触发 scan/hash/FFmpeg/model load/download/index rebuild。
- 重工作必须 durable task。
- 未实际执行成功的 gate 只能写 `NOT RUN`。

---

# Task A — 完成 Stage 17 Audio Editing UX

底层已经完成：

- `desktop/src/features/editor/timelineAudioEditing.ts`
- `desktop/src/features/editor/timelineAudioEditing.test.ts`
- Rust Timeline 已支持 audio track 上标准 Insert/Overwrite/Split/Trim/Move/RippleDelete。
- Python Delivery 已支持 A-track -> connected audio-only `asset-clip`。
- Delivery UI 已显示 audio track/clip 数并修正文案。

只剩 `TimelineWorkbench.tsx` 的可见接线。

## A1. 修改 import

文件：

```text
desktop/src/features/editor/TimelineWorkbench.tsx
```

加入：

```ts
import {
  audioInsertCutsExistingClip,
  audioTrackId,
  buildManualAudioCommand,
  type ManualAudioEditMode,
} from "./timelineAudioEditing";
```

不要复制 helper 到 Workbench。

## A2. 分开 Video / Audio preflight

现有：

```ts
const insertBlocked = sequence ? insertCutsExistingClip(sequence, playhead) : false;
```

改成语义明确的变量：

```ts
const videoInsertBlocked = sequence ? insertCutsExistingClip(sequence, playhead) : false;
const audioTargetTrackId = sequence ? audioTrackId(sequence) : null;
const audioInsertBlocked = sequence ? audioInsertCutsExistingClip(sequence, playhead) : false;
```

后续所有旧 `insertBlocked` 改为 `videoInsertBlocked`。

## A3. 保留现有 Video edit helper

现有 `editFromSource(mode)` 继续调用：

```ts
buildManualSourceCommand(...)
```

只把提示改成明确 `Video`：

```text
Insert Video
Overwrite Video
```

不要改变 Review / multicam / source range authority。

## A4. 新增 Audio helper

在 `editFromSource` 附近加入：

```ts
function editAudioFromSource(mode: ManualAudioEditMode): void {
  if (!snapshot || !sequence || !sourceOption) {
    setMessage("需要先选择一个可播放 Source。");
    return;
  }
  if (sourceRangeError) {
    setMessage(sourceRangeError);
    return;
  }
  if (!audioTargetTrackId) {
    setMessage("当前 Timeline 没有独立音频轨 A1。");
    return;
  }
  if (mode === "insert" && audioInsertBlocked) {
    setMessage("Insert Audio 播放头位于现有音频片段内部；请先切分，或改用 Overwrite Audio。");
    return;
  }
  try {
    const command = buildManualAudioCommand(
      mode,
      snapshot,
      sequence,
      sourceOption,
      sourceIn,
      sourceDuration,
      playhead,
    );
    void apply(
      command,
      `${mode === "insert" ? "Insert Audio" : "Overwrite Audio"} 完成 · ${sourceOption.label} · ${frameLabel(sourceDuration)} @ ${frameLabel(playhead)}`,
    );
  } catch (error) {
    setMessage(errorMessage(error));
  }
}
```

不要在 React 直接修改 track.clips。

## A5. Source panel 显式提供 4 个动作

把旧按钮：

```text
Insert
Overwrite
```

改为：

```text
Insert Video
Overwrite Video
Insert Audio
Overwrite Audio
```

建议：

```tsx
<div className="timeline-edit-actions">
  <button
    type="button"
    className="secondary"
    disabled={busy || Boolean(sourceRangeError) || videoInsertBlocked}
    onClick={() => editFromSource("insert")}
  >
    Insert Video @ {frameLabel(playhead)}
  </button>
  <button
    type="button"
    disabled={busy || Boolean(sourceRangeError)}
    onClick={() => editFromSource("overwrite")}
  >
    Overwrite Video @ {frameLabel(playhead)}
  </button>
  <button
    type="button"
    className="secondary"
    disabled={busy || Boolean(sourceRangeError) || !audioTargetTrackId || audioInsertBlocked}
    onClick={() => editAudioFromSource("insert")}
  >
    Insert Audio @ {frameLabel(playhead)}
  </button>
  <button
    type="button"
    className="secondary"
    disabled={busy || Boolean(sourceRangeError) || !audioTargetTrackId}
    onClick={() => editAudioFromSource("overwrite")}
  >
    Overwrite Audio @ {frameLabel(playhead)}
  </button>
</div>
```

Source In/Out 是四个动作共用的人工选区。

## A6. UI 提示

Warnings 必须区分：

```tsx
{videoInsertBlocked ? <span>Insert Video 位于现有视频片段内部；先切分或使用 Overwrite Video。</span> : null}
{audioInsertBlocked ? <span>Insert Audio 位于现有音频片段内部；先切分或使用 Overwrite Audio。</span> : null}
{!audioTargetTrackId ? <span>当前 Timeline 没有独立音频轨；Audio Insert/Overwrite 不可用。</span> : null}
```

标题建议改为：

```text
人工 Video / Audio Insert / Overwrite
```

不要添加隐式“linked/unlinked”状态。

## A7. Stage 17 验收

至少运行：

```bash
cd desktop
npm install
npm run typecheck
npm test
```

必须确认：

- `timelineAudioEditing.test.ts` PASS
- `timelineSourceEditing.test.ts` PASS
- `timelineSourceMarks.test.ts` PASS
- `timelineSyncEditing.test.ts` PASS
- Workbench typecheck PASS

如果 Vitest 缺 Workbench 行为测试，可新增一个**纯 helper/component contract**，不要为了测试把 Timeline authority 搬进 React。

---

# Task B — 全量 Source Gate Closure

回到仓库根目录。

## B1. Python-only gate

```bash
python scripts/check_python.py
```

必须包括并通过：

```text
test_repository_layout_guard.py
test_runtime_read_paths_contract.py
test_runtime_stack_installation.py
test_device_tasks.py
test_delivery_semantics.py
test_delivery_artifact_paths.py
test_timeline_delivery.py
test_timeline_delivery_sync.py
test_timeline_audio_delivery.py
test_golden_production_project.py
test_python_package_migration_contract.py
```

不要删测试拿绿灯。

## B2. Fast gate

```bash
python scripts/check_fast.py
```

它会运行：

- baseline guard
- runtime media tool policy
- TS strict typecheck
- Vitest
- Rust Timeline Core tests
- Tauri timeline tests
- Tauri persistence tests
- Tauri cargo check
- Python-only gate

如果出现 Rust test filter `0 tests`，修 gate/filter，不算 PASS。

## B3. Full RC gate

```bash
python scripts/check_full.py
```

等价核心入口：

```bash
cd desktop
npm run verify:rc
```

失败必须定位并修复，不跳过。

## B4. 记录 evidence

创建：

```text
docs/verification/2026-08-29-production-readiness.md
```

记录：

- tested commit SHA
- Python gate result
- fast gate result
- full gate result
- Node/npm/Python/Rust versions
- elapsed times
- any fixed failures

只有实际执行的写 PASS。

---

# Task C — Packaged Desktop / Native Smoke

macOS 是本轮主 native 验证环境。

## C1. Build/runtime staging

```bash
cd desktop
npm run stage:runtime
npm run verify:rc
npm run tauri -- build
npm run verify:macos-bundle
```

如果项目已有签名/notarization 环境但不是本次必要条件，不要为了签名阻塞本地 smoke；但必须区分“可构建 App”与“发布签名 App”。

## C2. Packaged App smoke

至少验证：

1. App 从 Finder/Applications bundle 启动，不依赖源码工作目录。
2. Production Host 正常拉起，`/api/v1/ping` identity/status 正确。
3. 新建项目和 reopen 项目。
4. 页面切换/Inspector 不触发 media scan/hash/model download。
5. Status Center 可看到 project/device durable task。
6. Local Vision / Identity prepare 可提交 device task。
7. 取消任务后 worker 停止；重启后旧 active task 标 interrupted。
8. Timeline checkpoint/journal reopen 成功。
9. stale authority 被拒绝并恢复最新 snapshot，不自动重放失败 edit。
10. Finder reveal/open path 只来自 localhost response，persisted report 无绝对设备路径。

把结果写进 verification 文档。

---

# Task D — Real Golden Media + Final Cut Pro Smoke

这一步必须在有真实 Final Cut Pro 的 macOS 上执行。

## D1. 建立最小真实项目

素材建议：

- 一个 24fps 或 24000/1001 的短视频素材 A，带 embedded audio；
- 一个同步/近同步第二机位 B；
- 至少一个可作为 independent A1 的带音频 asset；
- 一个小 FCPXML Project，确保 `material_index` 能解析 `clip_id -> source_asset_id`。

不要把真实媒体提交 Git。

## D2. 真实生命周期

完成：

```text
FCPXML/media import
-> Review/Slate mapping
-> explicit Best / playable source pool
-> Rough Cut proposal
-> confirm Timeline
-> Source Mark In/Out
-> Insert Video
-> Overwrite Video
-> multicam switch
-> Insert Audio on A1
-> Trim / Split / Move / Undo / Redo
-> checkpoint
-> reopen
-> authoritative Timeline Delivery
-> open generated FCPXML in Final Cut Pro
```

## D3. Final Cut Pro 验证点

必须人工确认：

- video clip 顺序/offset 正确；
- trim/source-in 正确；
- multicam flatten 后画面来自当前 selected angle；
- selected angle 的相对 Take 时间没有错位；
- embedded asset audio 仍可听；
- independent A1 以 connected audio 导入；
- A1 offset/source range/duration 正确；
- audio 超过视频尾部时 trailing anchor gap 不截音频；
- 没有意外重复音频；
- timeline duration 正确；
- FCP 不报 XML parse/DTD 结构错误。

若 FCP 导入失败，保留生成的 FCPXML 和错误截图/日志在本地验证目录，不提交包含设备路径/真实媒体的敏感 artifact。

## D4. 更新 verification

记录：

```text
FCP smoke: PASS / FAIL
Final Cut Pro version
macOS version
source frame rate
embedded audio result
independent audio result
multicam selected-angle result
```

---

# Task E — Final Integration to main

只有 Task A-D 适用 gate 完成后执行。

参考：

```text
docs/engineering/INTEGRATION_PLAN.md
```

## E1. 保留原开发分支

不要删：

```text
fix/runtime-read-paths
feature/timeline-*
feature/timeline-audio-ux
```

可建立 archive ref。

## E2. Integration worktree

```bash
git switch main
git pull --ff-only
git worktree add ../mirrororder-integration -b integration/production-readiness-1 main
cd ../mirrororder-integration
git merge --squash feature/timeline-audio-ux
```

先不 commit。

## E3. Diff audit

```bash
git diff --cached --stat
git diff --cached --check
git diff --cached --name-status
```

检查没有：

- real workspace
- media
- caches/output
- model weights
- secrets
- absolute device paths
- accidental binaries
- unrelated experiments

## E4. Squash tree 再跑 gates

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

重新跑 applicable packaged/FCP smoke。不要继承 feature branch 的 PASS。

## E5. Commit

建议：

```text
feat: harden production runtime and authoritative editing workflow
```

之后：

```bash
git status --short
git log -1 --stat
python scripts/check_fast.py
```

确认 clean，再 fast-forward / merge 到 main。

## E6. 最后更新 docs

更新：

```text
docs/engineering/STATUS.md
docs/verification/2026-08-29-production-readiness.md
```

绑定最终 main commit SHA。

---

# Task F — Cleanup

本次远端 API 会话误建了两个无代码价值的临时分支；确认它们没有独有 commit 后删除：

```bash
git push origin --delete tmp-unused tmp-audio-stage16-working
```

如不存在则忽略。

不要删除真正的 Stage/feature 审计分支，除非用户另行要求。

---

# Optional P2 — 不阻塞本轮 Production Beta

只有 A-F 完成后再做：

1. Program Monitor 单一 A/V clock、音频监听、scrub/mute/solo 基础语义。
2. Source Browser 搜索 / Episode / Scene / Take / Camera 分组，避免大项目 select 下拉失控。
3. 第一批 Python package migration：`fcpxml_reader.py + fcpxml_exporter.py -> adapters/fcpxml/`。
4. 自动配乐 / 自动剪辑继续 isolated experiment，输出 proposal，不能直接获得 Timeline authority。

不要把这些 P2/P3 插进本轮 squash commit。

---

# 最终完成定义

只有以下全部满足，才把本轮标记为 Production Beta ready：

- [ ] Stage 17 四个 Video/Audio Source edit 动作可达
- [ ] Python source gate PASS
- [ ] fast gate PASS
- [ ] full RC gate PASS
- [ ] TS/Vitest PASS
- [ ] Rust Timeline/Tauri PASS
- [ ] packaged macOS App smoke PASS
- [ ]真实 Timeline reopen / stale authority smoke PASS
- [ ]真实 FCPXML / Final Cut Pro video smoke PASS
- [ ] embedded + independent audio FCP smoke PASS
- [ ] squash integration tree 复验 PASS
- [ ] final main commit clean
- [ ] verification 文档绑定最终 commit

任何未执行项保持 `NOT RUN`，不得用 source review 代替。
