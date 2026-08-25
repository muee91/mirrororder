# 镜序 Desktop Bridge

这份文档定义当前 `desktop/` 客户端与 Python Core、Rust Timeline Core、Team Web 和本机平台能力之间的边界。

## 1. Production Desktop

```text
React / TypeScript UI
        ↓ typed contracts
Tauri 2 / Rust
  ├─ Production Host lifecycle :8765
  ├─ Team Gateway lifecycle    :8766
  ├─ native dialogs / reveal / URL / FCP adapter
  └─ Timeline bridge
        ↓
Python MirrorOrder Core + Rust Timeline Core
```

- React 负责交互，不拥有业务权威。
- Python Core 负责项目、Review、Slate、Identity、Assistant、媒体身份和 FCPXML delivery 语义。
- Rust Timeline Core 负责 authoritative local timeline edit state。

## 2. Team Web 独立

Team Web 是浏览器 Review / Projection surface，不是 Production project tab。

Desktop 可以管理 Gateway 的启动/停止、LAN/仅本机模式、pairing/trusted-LAN 和打开链接，但不得复制 Team Web 的权限或 Review 业务规则。

Production Host 与 Team Gateway 使用独立 Tauri manager；停止一个不得影响另一个。

## 3. 本机媒体

```text
clip_id / media_id
→ device-local media resolver
→ 当前设备真实媒体路径
→ HTTP Range / proxy transport 或后续窄 native adapter
```

- 绝对路径不得写回共享 workspace。
- 缺媒体必须明确显示。
- 视频帧/代理数据不得通过 Tauri JSON/Base64 IPC 大量搬运。
- 普通 Team Web 不获得宿主机文件路径。

## 4. Timeline

Rust Timeline Core 是唯一 authoritative edit state。

当前命令包括：Insert、Overwrite、Move、Split、Trim、RippleDelete、Disable、MulticamSwitch、SetMarker，以及 Undo/Redo。

Timeline persistence 使用 checkpoint + append-only journal + crash recovery。React 只读取 snapshot 和提交 command；Python proposal 不得直接修改 Timeline。

AI/rough-cut 进入 Timeline 的路径：

```text
evidence / rough-cut proposal
→ human confirmation
→ deterministic Rust commands
→ authoritative Timeline
```

## 5. Source / Program Monitor

当前监视器使用 Host media path / proxy transport，并由 Timeline playhead、clip source 与 multicam selected angle 解析当前媒体。

- 当前 J/K/L 属于 proxy transport。
- native A/V clock、frame-accurate playback 等必须以真实平台 smoke 为准。
- 不能因为 UI 有播放按钮就宣称 native playback gate 已完成。

## 6. FCPXML / NLE

- 不修改用户原始 FCPXML。
- 当前 delivery 继续复用 Python exporter。
- macOS Final Cut adapter 只做窄平台动作，不重写 FCPXML 业务逻辑。
- Resolve/Premiere 或其它 NLE adapter 默认先独立 worktree，只有 contract、authority、failure isolation 和 native smoke 明确后再并入主线。

## 7. 重功能隔离

当前主线只承载稳定产品面。以下能力默认独立开发：

- `work/runtime-packaging`
- `work/auto-score`
- heavy media processing
- new NLE adapters
- model runtime infrastructure
- experimental automation engines

## 8. 验证

```bash
cd desktop
npm install
npm run verify:rc
```

真实发行仍需 macOS/Windows packaged runtime、媒体播放、多机位、Timeline recovery、LAN Gateway、Final Cut / installer 等 native smoke。
