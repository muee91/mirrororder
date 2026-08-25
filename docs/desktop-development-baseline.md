# 镜序 Desktop 开发基线

`main` 是当前唯一开发基线。Desktop 客户端位于 `desktop/`，不再使用迁移阶段编号或“v2”命名。

## 架构边界

```text
React / TypeScript
        ↓ typed localhost/native contracts
Tauri 2 / Rust
  ├─ Production Host lifecycle :8765
  ├─ Team Gateway lifecycle    :8766
  ├─ platform adapters
  └─ Rust Timeline bridge
        ↓
Python MirrorOrder Core + Rust Timeline Core
```

- Python Core：workspace/project、Review、Slate、Identity、Assistant、AI proposals、media identity/binding、Team Web security/review、FCPXML delivery 业务权威。
- Rust Timeline Core：本机 authoritative timeline edit state、deterministic commands、validation、undo/redo、persistence/recovery。
- React/TypeScript：生产交互层，不得成为第二套业务或 Timeline source of truth。
- Team Web：独立 review/projection surface；Desktop 只管理其本机生命周期与打开入口。

AI 权限链保持：

```text
evidence → proposal → human confirmation → authority
```

## 当前产品面

当前 Desktop 基线包括：项目生命周期、素材/剧本归集、场记、人物/说话人身份、小镜 Assistant、本机素材绑定、设置/状态、Rust Timeline、Source/Program Monitor proxy workbench、Team Web Gateway、FCPXML delivery 与 macOS Final Cut adapter。

机器可读状态见：

`desktop/development-baseline.json`

## 本地验证

```bash
cd desktop
npm install
npm run verify:rc
```

也可以分别执行：

```bash
npm run check:baseline
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cd ..
python -m pytest -q
```

GitHub Actions 不是开发基线的必要条件；但未实际执行的检查不得写成通过。

## 发行门禁

当前仍需要真实环境验证：packaged Python/runtime、ffmpeg/ffprobe、macOS/Windows Tauri build、真实媒体播放、多机位同步、Timeline recovery、Final Cut import、Team Web LAN、codesign/notarization、Windows installer/WebView2。

## 重功能隔离

以下工作默认独立 branch/worktree：

- `work/runtime-packaging`：portable Python、media toolchain、Tauri resources、打包运行时。
- `work/auto-score`：自动配乐/音乐分析与生成。
- 其它重媒体处理、新 NLE adapter、模型 runtime infrastructure、实验自动化引擎。

只有 typed contract、authority boundary、failure isolation 和 native smoke gate 明确后，才并入主工作区。
