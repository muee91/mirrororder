# Engineering Status

更新时间：2026-09-05

## 当前基线

- 仓库只维护 `main` 作为开发与集成线。
- 当前产品代码基线：`b29ae57b883bab22e20e99d21d64aeba23e023c9`（`refactor: converge material and script production surfaces`）。
- 当前文档更新只规范产品定义、P0 Recovery 计划与状态记录，不改变产品行为。

## 当前产品状态：Desktop Product Recovery

当前 Desktop Production **不能视为已恢复可用**。

真实使用反馈已经明确：素材、剧本、时间线、审阅的产品编排目前过度耦合，导航、对象上下文和动作 ownership 不够清楚，核心工作流比历史 Swift V1 更难使用。

目前最明确的结构性问题是：

- `MaterialScriptWorkbench` 同时承担 `takes / script / review` 多个一级工作流；
- 工作区之间复用了 workflow orchestration，而不只是复用 canonical production objects；
- placement、素材治理、审阅上下文、drawer/filter 等职责在同一超级组件内交叉；
- 这使得“当前在处理什么、哪个工作区拥有这个动作、跨区后如何继续当前对象”变得不稳定。

因此当前最高优先级是 [`BACKLOG.md`](./BACKLOG.md) 中的 **P0 — Desktop Product Recovery**，不是新增功能、AI 展示或进一步扩张页面。

产品定义与 Recovery 验收以 [`../app-information-architecture.md`](../app-information-architecture.md) 为准。一级工作区固定为：

```text
素材 / 剧本 / 时间线 / 审阅
```

工程实现原则：

> **共享对象，不共享工作流。**

P0 最低可用性 happy path：

1. 找到一个实际 Take；
2. 理解其拍摄事实、机位和当前归属；
3. 修正到正确剧本位置；
4. 看片并完成人工决定；
5. 把需要的素材 / 决定带到时间线继续剪。

五步未在真实项目真机顺畅走通前，不能因为功能数量、组件复用或自动测试数量而宣称产品恢复完成。

## 最近真实 CI

GitHub Actions **MirrorOrder CI #1218**，run `33960530475`，目标 commit `b29ae57b883bab22e20e99d21d64aeba23e023c9`：**FAIL**。

### Python job

- Python compile：**PASS**。
- pytest：**FAIL**。
- 结果：`1 failed, 558 passed, 3 skipped`。
- 失败：`tests/test_desktop_bridge.py::test_desktop_project_navigation_matches_reduced_production_authority`。
- 这是 stale source-shape contract：仍要求 `ProjectWorkbench.tsx` 包含旧字符串 `const materialScript = page === "takes" || page === "script"`，与当前实现形状不一致。

### Desktop Linux job

- dependency / icons：**PASS**。
- development baseline：**PASS**。
- UI authority：**FAIL**。
- 失败原因：compact Take styling 出现两个 owner：
  - `src/features/material-script/material-script-workbench.css`
  - `src/features/material-script/take-card.css`
- TypeScript typecheck、Vitest、frontend build、Rust Timeline tests、Tauri Host tests / check：因 authority gate fail-fast **SKIPPED**。

因此当前 `main` 没有全链路 CI green 证据，也不能把后续未执行步骤写成 PASS。

这两处 CI red 应在 P0 workspace ownership / canonical styling 收口时修复；不要为了旧实现形状保留错误架构，也不要弱化 authority gate 来制造绿灯。

## 当前 authority 基线

- Script Supervisor / Slate：拍摄现场与素材附件人工事实。
- ReviewStore：人工 script placement / mapping authority。
- Final Editorial Decision：与 Review placement 分离的最终人工剪辑判断。
- Rust Timeline Core：本机 authoritative Timeline edit state。
- Python MirrorOrder Core：Workspace/Project、Review、Slate、Identity、Assistant proposals、media identity/binding、Team Web security/review、Delivery/FCPXML 等业务 authority。
- React/Tauri：Production UI 与 device integration，不创建第二套业务 truth。
- AI 保持 `evidence → proposal → human confirmation → authority`。
- device-local absolute path 不进入共享项目 artifact、Timeline/Review/Delivery authority 或 durable task target。

## P0 执行入口

下一轮代码工作从以下顺序开始：

1. **P0.1** — 清点 route / Workbench / action ownership，冻结产品面扩张；
2. **P0.2** — 拆除 `MaterialScriptWorkbench` 跨域万能 Workbench，形成独立 `MaterialWorkspace / ScriptWorkspace / ReviewWorkspace`；Timeline 保持独立；
3. **P0.3** — 恢复 Material happy path；
4. **P0.4** — 恢复 Script-first placement happy path；
5. **P0.5** — 恢复 Timeline 唯一剪辑中心；
6. **P0.6** — 恢复 Review 的看片 + 决定职责；
7. **P0.7** — 建立 typed cross-workspace selection/navigation intent；
8. **P0.8** — 收口 stale contracts / UI authority / CSS owner，并做阶段验证；
9. **P0.9** — 使用真实项目做真机五步可用性验收。

执行时 main-only；优先完成功能切片，再做必要 targeted validation；非必要不手动反复触发 CI，阶段收口后统一验证。

## 其它未关闭风险

P0 Product Recovery 之外仍存在但暂不抢占优先级：

- Finder/Explorer 原生跨窗口拖入真实 GUI smoke；
- Final Cut Pro authoritative FCPXML import smoke；
- codesign/notarization 与 Windows installer 发布 gate；
- Desktop 全局 CSS 多层 ownership；
- Web hidden compatibility DOM；
- migration-era naming cleanup。

这些除非直接阻塞 P0 主链，否则按 `BACKLOG.md` 的 P1/P2 顺序处理。

## 状态维护规则

- 这里只写当前事实和未关闭风险。
- 已完成阶段、旧分支 SHA、历史评分和长验收清单进入 `docs/verification/` 或 Git 历史。
- PASS 只属于实际执行过的目标 commit/run。
- 产品“可用”必须有真实工作流证据；自动 gate 只是一部分。
- 新的长期规则进入 `DECISIONS.md` / `INVARIANTS.md`，不继续把本文件扩成设计文档。
