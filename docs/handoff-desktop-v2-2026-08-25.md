# Desktop v2 会话交接（2026-08-25）

## 当前基线

旧架构功能分支：

- `feat/post-material-card-spec`
- 原用户冻结提交：`40ac37ff0d5dbc8721b2177870dbc63e07b22229`
- Web 小镜收尾提交：`6ab56e6800021bf3427872bc42de4aced47a82ac`

PR #7：`feat: rough-slate-first post-production workbench`

新的重构分支：

- `feat/desktop-v2-tauri`
- 从 `6ab56e6` 分出

## 6ab56e6 的关键收尾

Team Web 首屏卡顿调查确认一个高风险热点：旧 `assistant_ui.js` 在首屏 `renderContent()` 后会遍历整个项目构建小镜队列，并通过逐组 `.find()` 查询 review model；大项目存在接近 O(n²) 的浏览器主线程成本，而且隐藏面板也会预先生成大量 DOM。

因此现在边界改为：

### Production App / Host

- 负责小镜计算
- 负责模型和 Agent 能力
- 负责 assistant payload
- 负责语义搜索配置

### Team Web

- 不加载完整 `assistant_ui.js`
- 不加载 `assistant_control_ui.js`
- 不加载 `semantic_search_ui.js`
- 使用新增 `assistant_projection_ui.js`
- 只有用户点击“小镜”才请求一次 `/assistant`
- 最多展开 40 条 Host 生成结果
- 不在 Web 自己遍历所有 Take 生成 assistant queue

同时：

- `material_card_ui.js`
- `post_workbench_ui.js`
- `placement_drag_ui.js`

从首屏同步脚本链移到 core first paint 之后的 idle 加载。

App 客户端仍会在 idle 阶段加载完整：

- `assistant_ui.js`
- `assistant_control_ui.js`
- `semantic_search_ui.js`

因此没有把制作端小镜功能删除。

## 已做验证

- 新 `startup_release.js` 使用 `node --check` 通过。
- 新 `assistant_projection_ui.js` 使用 `node --check` 通过。
- 远端 `6ab56e6` 已核对提交内容。
- 没有触发 GitHub Actions。

旧冻结 handoff 中已有：

- `python3 macos-app/prebuild_check.py` 通过
- 最近一次完整回归 `333 passed`
- `/api/v1/ping` 正常
- 最后一轮完整 App build 在用户侧被中断，因此 `6ab56e6` 仍需要真实 Mac 重新 build/launch smoke 才能作为最终旧版包发布

## 已知旧版剩余平台验证

1. 真机 Team Web 首屏：确认 `6ab56e6` 已消除首屏绘制后主线程冻结。
2. macOS App：重新运行最终 `build_ready.sh / build_app.sh`。
3. 真实竖屏素材：确认 `AVPlayerItem.presentationSize` 驱动的布局回调。

这些不阻止 Desktop v2 架构开发，但如果要正式发布旧 SwiftUI 版本，仍需补齐。

## Desktop v2 已确定技术方向

不要在新会话重新做框架选型。

目标：

- Tauri 2
- React
- TypeScript
- Rust native host / Timeline Core
- 继续保留 Python MirrorOrder Core
- macOS + Windows

完整迁移方案见：

`docs/desktop-v2-tauri-plan.md`

## 新会话第一条任务

直接继续：

> 继续镜序 Desktop v2。读取 `docs/handoff-desktop-v2-2026-08-25.md` 和 `docs/desktop-v2-tauri-plan.md`，核对 `feat/desktop-v2-tauri` 最新 HEAD，然后开始 Phase 1：建立 Tauri 2 + React/TypeScript 骨架和 HostConnection。不要重新讨论 Swift/Tauri 选型，也不要重写 Python Core。

## 必须保留的产品语义

- 粗手写场记正常输入
- episode-only 一等状态
- shot size 是 angle/clip 级
- AI proposal → human confirmation → authority
- 人工 slate/shot/note 优先
- Team Web 是审阅投影，不承担制作端重计算
- 小镜完整能力在 App/Host
- Windows 目标不能牺牲 macOS FCP adapter
