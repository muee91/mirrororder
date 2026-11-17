# 镜序 Desktop Bridge

这份文档定义当前 `desktop/` 客户端与 Python Core、Rust Timeline Core、Team Web 和本机平台能力之间的边界。

## 1. Production Desktop

```text
React / TypeScript UI
        ↓ typed contracts
Tauri 2 / Rust
  ├─ Production Host lifecycle :8765
  ├─ Team Gateway lifecycle    :8766
  ├─ native dialogs / reveal / URL / NLE adapter
  └─ Timeline bridge
        ↓
Python MirrorOrder Core + Rust Timeline Core
```

- React 负责交互，不拥有业务权威。
- Python Core 负责项目、Review、Slate、Identity、Assistant、媒体身份和 FCPXML delivery 语义。
- Rust Timeline Core 负责 authoritative local timeline edit state。
- Production Host / Team Gateway 由 Desktop 统一管理：启动时只回收同一工作区、同一配置留下的旧镜序服务；任意其它监听者仍 fail closed。Tauri 将父进程标识传给 Python 服务，父进程异常消失时服务自终止，避免应用替换或崩溃留下固定端口孤儿进程。
- macOS / POSIX 的本地视觉模型通过 `local_models.supervisor` 启动；守护进程只拥有本次创建的模型进程，Host 正常停止或被强制结束时均回收模型，并阻止 Host 消失后的延迟启动。不能只依赖 Python `atexit`，因为 Host 被强制结束时不会执行它。Windows 启动路径保持独立，不能用本机 POSIX 验证代替 Windows 生命周期验收。

## 2. Team Web 独立

Team Web 是浏览器 Review / Projection surface，不是 Production project tab。

Desktop 可以管理 Gateway 的启动/停止、LAN/仅本机模式、pairing/trusted-LAN 和打开链接，但不得复制 Team Web 的权限或 Review 业务规则。

Production Host 与 Team Gateway 使用独立 Tauri manager；停止一个不得影响另一个。

## 3. 本机媒体

```text
clip_id / media_id
→ device-local media resolver
→ 当前设备真实媒体路径
→ HTTP Range / proxy transport 或窄 native adapter
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
- Resolve/Premiere 或其它新 NLE adapter 必须先形成独立、可验证的 adapter boundary；contract、authority、failure isolation 和 native smoke 明确后，才进入常规 Production 路径。

## 7. 重功能隔离

仓库当前使用 `main`-only 工作流。重 runtime、自动配乐、heavy media processing、新 NLE adapter、model runtime infrastructure 和实验自动化引擎的隔离依赖：

- 独立 package/process/runtime boundary；
- typed contract；
- scoped atomic commit；
- 明确 failure isolation；
- 需要时使用 feature gate；
- 对应 source/native smoke。

长期 branch/worktree 不是当前架构前提。

## 8. 验证

```bash
cd desktop
npm install
npm run verify:rc
```

真实发行仍需 macOS/Windows packaged runtime、媒体播放、多机位、Timeline recovery、LAN Gateway、Final Cut / installer 等 native smoke。
