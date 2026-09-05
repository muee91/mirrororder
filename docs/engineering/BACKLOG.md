# Engineering Backlog

当前最高优先级不是新增能力，而是恢复 Desktop 产品主链的真实可用性。

## P0 — Desktop Product Recovery

### 总验收

真实项目必须顺畅完成：

1. 找到一个实际 Take；
2. 看懂它的拍摄事实、机位和当前归属；
3. 把它修正到正确剧本位置；
4. 看片并完成需要的人工决定；
5. 把需要的素材 / 决定带到时间线继续剪。

五步没有在真机真实项目走通前：不新增一级产品面，不扩展 AI 展示，不启动与主链无关的大型重构，不继续制造新的万能 Workbench。

### P0.1 — 明确 workspace ownership

- Desktop 一级工作区固定：`素材 / 剧本 / 时间线 / 审阅`。
- 清点 route、Workbench、drawer、hidden page、secondary nav、cross-workspace action、selection state。
- 每个动作只允许一个 primary home：Material / Script / Timeline / Review / Global Tool。
- 兼容 route 只做 canonicalization，不拥有新 UI。

完成条件：任何核心动作都能明确回答“它属于哪个工作区”，不再依赖“另一个 surface 也能改”。

### P0.2 — 拆除跨域万能 Workbench

当前 `MaterialScriptWorkbench` 同时承担 takes / script / review，是 P0 的核心切除对象。

目标：

```text
MaterialWorkspace
ScriptWorkspace
TimelineWorkspace
ReviewWorkspace
```

要求：

- 保留 canonical `TakeCard / TakeListRow / ScriptBlock / MediaCard / SlateRow / PersonRow`；
- 不复制对象 renderer；
- 分离 loader/orchestration、selection、toolbar、drawer、filter、写权限；
- 不再使用 `surface="takes|script|review"` 或同义 mode 合并多个一级工作区；
- 迁移 consumer 后删除失去 owner 的旧分支、CSS 和 stale contract。

完成条件：Material / Script / Review 可以分别读懂源码和运行时行为，不需要追踪一个超级组件的条件树。

### P0.3 — 素材：恢复资产与拍摄事实中心

- 场记 Table 是明确主画布；一行 = 一次实际拍摄记录。
- 素材库、Take、人物是同一 Material workspace 的 view/task，不是互相竞争的 App。
- Take 清楚展示机位、拍摄事实、素材可用性和当前剧本归属摘要。
- relink / 本机素材修复是 contextual tool。
- 从 Take 可明确“在剧本中打开 / 在审阅中打开 / 在时间线中打开”。

禁止：Final Editorial Decision、完整 Script workspace、Timeline edit 混入 Material。

完成条件：剪辑人员能从真实素材快速找到并理解 Take，而不是先理解镜序内部数据模型。

### P0.4 — 剧本：恢复 Script-first placement

- Script / ScriptBlock 是 Primary Canvas。
- 集 / 场 / 搜索只服务剧本扫描。
- 选中 ScriptBlock 后按需显示已归集 Take、候选 Take、必要证据。
- App 内 Review placement / mapping 修正以 Script workspace 为主家。
- Coverage 是同一 Script 上下文的 projection，不是独立 Workbench。
- Take picker/detail 用 drawer / Inspector，不常驻完整素材池第二工作台。

完成条件：用户从“这一段剧本缺什么”直接找到候选并完成人工归集，不离开剧本主上下文。

### P0.5 — 时间线：唯一剪辑中心

- Rust Timeline Core / Timeline workspace 保持唯一 authoritative local editor。
- source browser、program monitor、tracks、selection、undo/redo、persistence 形成一条明确主路径。
- Rough Cut / Assembly / AI editing 只产生 proposal / preview；人工确认后才转换为 Timeline commands。
- Delivery/export 是 Timeline 后续 flow，不建立第二 editor。
- Material / Script / Review deep-link 到 Timeline 时保留当前 Take / clip context。

完成条件：用户清楚知道真正剪片只在 Timeline 发生。

### P0.6 — 审阅：只做看片 + 人工决定

- Viewer / playback 第一优先级。
- 当前 Take、机位、必要 Script context 清楚。
- Best / Keep / Reject / Final Editorial Decision 明确可操作。
- “需关注”只做 filter / queue；团队意见、stale evidence、问题原因进入 context/Inspector。
- 不复制场记编辑、素材 relink、人物治理、批量归集、完整 placement editor 或 Timeline edit。
- placement 错 → 在剧本中打开；素材错 → 在素材中打开；剪辑问题 → 在时间线中打开。

完成条件：看片和决定不被其它工作区的治理按钮打断。

### P0.7 — 统一跨工作区 Project Context

建立最小 typed navigation intent，至少能携带：

```text
project
Take / group
clip / media
episode / scene / ScriptBlock
Timeline item / source clip
```

要求：

- context 只保存 selection / navigation intent，不成为业务 truth；
- deep-link 不绕过目标 workspace authority；
- 切 workspace 后不要求用户重新找同一个对象；
- resume state 只恢复 canonical workspace/view。

### P0.8 — 收口 product contract / UI authority

结构稳定之后再统一处理：

- product surface contract 锁定四 workspace；
- UI authority gate 禁止跨域万能 Workbench 回流；
- canonical renderer ownership 不回退；
- stale source-shape tests 改成真实产品/authority contract；
- 删除只约束旧实现形状的断言，不删除真正行为红线；
- 修复当前已知 CI red：Python stale navigation contract、compact Take CSS 双 owner。

不要在每个中间微调上手动反复跑 CI；完成 coherent slice 后做必要 targeted validation，P0 收口再做完整验证。

### P0.9 — 真实项目真机验收

使用《在制项目》或同等规模真实项目，至少验证：

- 项目恢复与切换；
- 大量 Take 查找与滚动；
- A/B/C 多机位可读性；
- 场记 → 素材 → 剧本 → 审阅 → Timeline 的连续对象上下文；
- placement revision 冲突；
- Viewer / media binding；
- Timeline source 与编辑主链；
- macOS 1280 与常用宽屏；
- light/dark；
- 外部文件拖放与 NLE 入口。

Swift V1 只作为最低可用性对照，不要求视觉复刻。

P0 关闭条件：五步主链真机可用 + 必要自动 gate 在目标 commit 上真实通过。

## P1 — P0 后的必要工程收缩

只在不抢占 P0 的前提下处理：

- Desktop 全局 CSS / theme / redesign / recovery ownership 收缩；
- Web hidden compatibility DOM 清理；
- `Golden* / *_v2 / *_v3 / recovery / redesign / frozen` 迁移期命名清理；
- 大项目 source browser 搜索、分组、camera/episode/scene filter；
- Program Monitor A/V clock 与音频监听；
- validation ergonomics。

这些工作必须服务现有四 workspace，不得借清理之名建立新产品面。

## 暂停事项

P0 期间暂停：

- 新 automatic editing engine；
- 自动配乐等实验功能；
- 新 AI Dashboard / 模型控制面；
- 与五步主链无关的大规模 Python package migration；
- 新一级 workspace / 独立 Workbench。

需要恢复这些事项时，必须先从当前产品需求重新立项，不能因为旧代码或旧文档存在就自动继续。

## Backlog 规则

- P0 期间任何工作先证明不会增加 workspace / authority / workflow 分叉。
- 条目描述用户问题、owner、完成条件和红线；不以“再加一层 abstraction”作为默认解法。
- 长期不可突破的规则进入 `INVARIANTS.md`。
- 已完成阶段从当前 backlog 删除；Git 历史保存过程。
