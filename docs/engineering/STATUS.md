# Engineering Status

更新时间：2026-09-05

## 当前基线

- 仓库只维护 `main`。
- Desktop 当前处于 **Product Recovery**，产品仍不能视为已恢复可用。
- 文档 authority 已收缩到产品定义、当前状态、当前 backlog、长期 invariants 与必要领域/跨层 contract。
- P0.1 / P0.2 已完成源码切分：Material / Script / Review 分别拥有独立 workspace renderer，跨域 `MaterialScriptWorkbench` 已移除。
- P0.3 已完成当前源码切片：Material 现在拥有场记 / 素材库 / Take / 人物四个内部视图，本机素材恢复降为 contextual tool。

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
├── TimelineWorkbench
└── ReviewWorkspace
```

Material 当前已经收口为同一个资产与拍摄事实中心：

- `ProjectWorkbench` 不再分别拥有 Slate / Media Library / Take / Identity / Binding 子页面 renderer；
- `MaterialWorkspace` 自己管理 `slate / library / takes / people` 四个 view；
- `repair` 只作为素材库上下文中的本机恢复工具，不成为新的产品面；
- Take view 会把 Review Take 与 Script Supervisor / Slate fact 关联，展示场 / 镜 / Take、场记状态、媒体可用性和当前剧本归属摘要；
- Take 支持按 Take、场镜次、机位、对白、备注搜索，并能筛选待归集 / 有候选 / 已归集 / 素材离线；
- 当前 Take 明确提供“在剧本中打开 / 在审阅中打开 / 到时间线 / 修复本机素材”；
- Material 仍不写 Review placement，也不承载 Final Editorial Decision。

其它 workspace authority 保持：

- Script 是 Desktop 人工 Review placement / mapping 修正的主要 owner；
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

P0.1–P0.3 已持续更新这些 source-shape contract 与 CSS ownership guard，但当前新 `main` 尚未执行完整验证，因此不能写 PASS。

执行策略保持：

- 先完成 coherent 功能切片；
- 只做必要 targeted validation；
- 非必要不手动反复触发 CI；
- P0 阶段收口后统一完整验证和真机验收。

## 下一轮代码入口

接下来直接进入 **P0.4 — Script-first placement**：

- Script / ScriptBlock 保持唯一 Primary Canvas；
- 把集 / 场 / 搜索、Coverage projection、已归集 Take、候选 Take、人工 placement 修正组织成一条连续任务；
- 减少“先选 Take 再找剧本”的工具感，优先从“这一段剧本缺什么 / 已经有什么”出发；
- Coverage 不再表现成独立工作台；
- 候选和 Take detail 保持 contextual，不重新形成第二素材池工作台；
- placement revision / actor / ReviewStore authority 保持不变。

之后顺序仍是：P0.5 Timeline → P0.6 Review → P0.7 typed project context → P0.8 contracts/CSS → P0.9 真机验收。

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
