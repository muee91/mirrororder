# Engineering Status

更新时间：2026-09-02

## 当前基线

- 仓库当前只维护 `main`。
- 最近产品代码基线：`9f17cce096fbec5ff8d75ce27dcfff3931281097`。
- 本文件所在文档整理不改变产品行为；历史 Stage/分支记录已退出当前状态文档。

## 最近真实 CI

GitHub Actions run `33634928494`（目标 `9f17cce`）：

- Python compile/tests：**PASS**。
- Desktop development baseline：**PASS**。
- TypeScript typecheck：**PASS**。
- Vitest：**PASS**。
- Desktop frontend build：**PASS**。
- Rust Timeline Core tests：**PASS**。
- Tauri Host tests：**FAIL**。
- Tauri `cargo check`：因前一步失败而 **SKIPPED**。

因此当前 `main` 不能标记为全链路 CI green；P0 是定位并修复 Tauri Host test failure，然后重跑完整流水线。

## 当前产品/authority 基线

- Python MirrorOrder Core：Workspace/Project、Review、Slate/Script Supervisor、Identity、Assistant proposals、media identity/binding、Delivery semantics。
- Rust Timeline Core：本机 authoritative Timeline edit state、commands、undo/redo、persistence/recovery。
- React/Tauri：Production UI 与 device integration，不创建第二套业务 truth。
- AI 保持 `evidence → proposal → human confirmation → authority`。
- device-local absolute path 不进入共享项目 artifact、Timeline/Review/Delivery authority 或 durable task target。

## 尚未关闭

1. **P0** — Tauri Host CI test failure；当前 CI 的唯一已知失败阶段。
2. Finder/Explorer 原生跨窗口拖入：真实 GUI smoke 仍未形成稳定 PASS 证据。
3. Final Cut Pro authoritative FCPXML import smoke：仍需真实 FCP 环境验证。
4. codesign/notarization、Windows native/installer：发布级 gate，当前未关闭。
5. Desktop CSS 多层 ownership、Web hidden compatibility DOM、migration-era naming：属于后续工程清理，不阻塞当前产品代码基线。

## 状态维护规则

- 这里只写当前事实和未关闭风险。
- 已完成阶段、旧分支 SHA、历史评分和长验收清单进入 `docs/verification/` 或 Git 历史。
- PASS 只属于实际执行过的目标 commit/run。
- 新的长期规则进入 `DECISIONS.md` / `INVARIANTS.md`，不继续扩写本文件。
