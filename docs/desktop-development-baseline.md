# 镜序 Desktop 开发基线

`main` 是当前唯一开发与集成基线。Desktop 位于 `desktop/`。

## 架构

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

- Python Core：Workspace/Project、Review、Slate、Identity、Assistant、media identity/binding、Team Web、Delivery/FCPXML 等业务 authority。
- Rust Timeline Core：authoritative timeline edit state、commands、validation、undo/redo、persistence/recovery。
- React/TypeScript：Production UI，不成为第二套业务或 Timeline truth。
- Team Web：独立 review/projection surface。

机器可读基线：`desktop/development-baseline.json`。

## Source validation

```bash
cd desktop
npm install
npm run check:baseline
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/crates/timeline-core/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

仓库级入口：

```bash
python scripts/check_python.py
python scripts/check_fast.py
python scripts/check_full.py
```

只有实际执行成功的目标 commit 可以写 PASS。CI 是额外执行环境，不能继承旧 PASS，也不能替代真实 native/packaged smoke。

## Native / release gates

源码 gate 之外仍需按发布目标验证：packaged Python/runtime、ffmpeg/ffprobe、macOS/Windows Tauri build、真实媒体播放、多机位同步、Timeline recovery、Final Cut import、Team Web LAN、codesign/notarization、Windows installer/WebView2。
