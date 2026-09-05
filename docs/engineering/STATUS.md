# Engineering Status

更新时间：2026-09-05

## 当前基线

- 仓库只维护 `main`。
- Desktop 当前处于 **Product Recovery**，产品仍不能视为已恢复可用。
- 文档 authority 已收缩到产品定义、当前状态、当前 backlog、长期 invariants 与必要领域/跨层 contract。
- P0.1 / P0.2 已进入源码拆分阶段：跨域 `MaterialScriptWorkbench` 已从当前目标结构移除，Material / Script / Review 分别拥有独立 workspace renderer。

## 当前 Product Recovery 状态

当前一级工作区固定为：

```text
素材 / 剧本 / 时间线 / 审阅
```

实现原则：

> **共享对象，不共享工作流。**

当前源码职责已经按以下方向收口：

```text
ProjectWorkbench
├── MaterialWorkspace
├── ScriptWorkspace
├── TimelineWorkbench
└── ReviewWorkspace
```

其中：

- Material 只读 Review placement 摘要，不直接写 placement，也不承载 Editorial Decision；
- Script 是 Desktop 内人工 Review placement / mapping 修正的主要 owner，并承载批量粗归集入口；
- Review 以 Viewer + 人工 Editorial Decision 为主，`需关注` 只是 filter，不复制 placement editor；
- Timeline 继续是唯一 authoritative local editor；
- canonical `TakeCard / TakeListRow / ScriptBlock / MediaCard / SlateRow / PersonRow` 继续复用，不复制 renderer。

这只是**源码结构收口**，不是产品可用性验收。P0 最低 happy path 仍必须在真实项目真机走通：

1. 找到实际 Take；
2. 理解拍摄事实、机位和当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到 Timeline 继续剪。

## 验证状态

最近已有的真实 CI 仍是 GitHub Actions **MirrorOrder CI #1218**，目标旧产品代码基线 `b29ae57b883bab22e20e99d21d64aeba23e023c9`：**FAIL**。

当时两处已知失败：

- Python stale navigation source-shape assertion；
- compact Take CSS 出现两个 owner。

本轮 P0.1 / P0.2 源码拆分已经针对这两类结构性问题更新对应 contract / authority owner，但**当前新 main 尚未执行完整验证，不能写 PASS**。

执行策略保持：

- 先完成 coherent 功能切片；
- 只做必要 targeted validation；
- 非必要不手动反复触发 CI；
- P0 阶段收口后再统一完整验证和真机验收。

## 下一轮代码入口

接下来按 P0 主链继续，不新增产品面：

1. **P0.3 — Material happy path**：场记 / 素材库 / Take / 人物成为清楚的资产与拍摄事实中心，并补齐“在剧本 / 审阅 / 时间线中打开”的对象连续性；
2. **P0.4 — Script-first placement**：剧本扫描、候选 Take、人工 placement 修正进一步压缩成单主画布流程；
3. **P0.5 — Timeline**：检查 source browser → monitor → tracks → undo/redo → persistence 主链；
4. **P0.6 — Review**：继续把看片 + 人工决定从制作治理噪音中剥离；
5. **P0.7 — typed project navigation intent**：替换当前最小 `focusedTakeGroupId` 过渡状态；
6. **P0.8 — contract / CSS ownership 收口**；
7. **P0.9 — 真实项目真机五步验收**。

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
