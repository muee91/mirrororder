# Engineering Status

更新时间：2026-09-05

## 当前基线

- 仓库只维护 `main`。
- Desktop 当前处于 **Product Recovery**，产品仍不能视为已恢复可用。
- P0.1 / P0.2 已完成源码切分：Material / Script / Review 分别拥有独立 workspace renderer，跨域 `MaterialScriptWorkbench` 已移除。
- P0.3 已完成：Material 收成一个资产与拍摄事实中心。
- P0.4 已完成当前源码切片：ScriptBlock 是剧本主对象，Coverage / 问题改为 Script 内部 projection，独立 Coverage route 已从 ProjectWorkbench 移除。

## 当前 Product Recovery 状态

一级工作区固定为：

```text
素材 / 剧本 / 时间线 / 审阅
```

实现原则：

> **共享对象，不共享工作流。**

当前职责：

```text
ProjectWorkbench
├── MaterialWorkspace
│   ├── 场记
│   ├── 素材库
│   ├── Take
│   └── 人物
├── ScriptWorkspace
│   └── 正文 / 覆盖 / 问题 projection
├── TimelineWorkbench
└── ReviewWorkspace
```

Material 当前：

- `MaterialWorkspace` 自己管理 `slate / library / takes / people` 四个 view；
- `repair` 只作为素材库上下文中的本机恢复工具；
- Take view 会关联 Script Supervisor / Slate fact，展示场 / 镜 / Take、场记状态、媒体可用性和当前剧本归属；
- 当前 Take 明确提供“在剧本中打开 / 在审阅中打开 / 到时间线 / 修复本机素材”；
- Material 不写 Review placement，也不承载 Final Editorial Decision。

Script 当前：

- Script / ScriptBlock 是唯一 Primary Canvas；
- 支持集数切换与“搜索剧本、角色或场景”；
- `正文 / 覆盖 / 问题` 是同一 Script canvas 的 projection，不再跳转独立 Coverage Workbench；
- Coverage projection 显示已归集 / 候选状态，明确不把“无 placement 证据”解释成“缺镜头”；
- 选中 ScriptBlock 后在 contextual drawer 查看相关 Take，并可直接“归集到此段”；
- 无候选时可以在同一 drawer 搜索全部 Take，仍由 Script workspace 写 Review placement；
- batch rough placement 保留为 Script 的 episode-only contextual tool；
- legacy `coverage` resume/page request canonicalize 到 `script`。

其它 workspace authority 保持：

- Review 以 Viewer + 人工 Editorial Decision 为主，`需关注` 只是 filter；
- Timeline 是唯一 authoritative local editor；
- canonical `TakeCard / TakeListRow / ScriptBlock / MediaCard / SlateRow / PersonRow` 继续复用，不复制 renderer。

这仍然只是**源码与交互结构恢复**，不是产品已经可用。最终最低 happy path 必须在真实项目真机走通：

1. 找到实际 Take；
2. 理解拍摄事实、机位和当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到 Timeline 继续剪。

## 验证状态

最近已有的完整真实 CI 仍是 GitHub Actions **MirrorOrder CI #1218**，目标旧代码基线 `b29ae57b883bab22e20e99d21d64aeba23e023c9`：**FAIL**。

当时两处已知失败：

- Python stale navigation source-shape assertion；
- compact Take CSS 出现两个 owner。

P0.1–P0.4 已持续更新 source-shape contract 与 UI authority guard，但当前新 `main` 尚未执行完整验证，因此不能写 PASS。

执行策略保持：

- 先完成 coherent 功能切片；
- 只做必要 targeted validation；
- 非必要不手动反复触发 CI；
- P0 阶段收口后统一完整验证和真机验收。

## 下一轮代码入口

接下来直接进入 **P0.5 — Timeline 唯一剪辑中心**：

- 核对 source browser → program monitor → tracks → selection → undo/redo → persistence 的真实主链；
- Material / Script / Review deep-link 到 Timeline 时，明确当前 Take / clip/source intent；
- Rough Cut / Assembly / AI editing 只作为 proposal / preview，不保留竞争性的 editor state；
- Delivery/export 降为 Timeline 后续 flow，不作为并列剪辑工作台；
- 删除失去产品 owner 的旧 planning/editor shell，而不是继续隐藏。

之后顺序：P0.6 Review → P0.7 typed project context → P0.8 contracts/CSS → P0.9 真机验收。

## 其它未关闭风险

P0 之外仍存在但暂不抢优先级：

- Finder/Explorer 原生跨窗口拖入真实 GUI smoke；
- Final Cut Pro authoritative FCPXML import smoke；
- codesign/notarization 与 Windows installer 发布 gate；
- Desktop 全局 CSS 多层 ownership；
- Web hidden compatibility DOM；
- migration-era naming cleanup。

## 状态维护规则

- 本文件只写当前事实和未关闭风险，不写阶段日志。
- PASS 只属于实际执行过的目标 commit/run。
- 产品“可用”必须有真实工作流证据；自动 gate 只是一部分。
- 历史阶段、旧分支、旧评分、某次 verification 使用 Git history / GitHub Actions 追溯。
- 新的长期规则进入 `INVARIANTS.md`，不把 STATUS 扩成设计文档。
