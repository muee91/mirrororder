# Engineering Backlog

这里只保存当前未关闭的工程事项。当前最高优先级不是新增能力，而是恢复 Desktop 产品主链的真实可用性。

## P0 — Desktop Product Recovery

### 目标

恢复镜序最核心的五步工作流：

1. 找到一个实际 Take；
2. 看懂它的拍摄事实、机位和当前归属；
3. 把它修正到正确剧本位置；
4. 看片并完成需要的人工决定；
5. 把需要的素材 / 决定带到时间线继续剪。

在这五步真实项目 happy path 没有顺畅走通前，不新增一级产品面，不扩展 AI 展示，不继续制造新的万能 Workbench。

### P0.1 — 冻结产品扩张，明确 workspace ownership

- Desktop 一级工作区固定为：`素材 / 剧本 / 时间线 / 审阅`。
- 清点当前 route、Workbench、drawer、hidden page、secondary nav 与 cross-workspace action。
- 为每个动作标记唯一 primary home：Material / Script / Timeline / Review / Global Tool。
- 只保留兼容 route canonicalization；兼容 route 不拥有新的 UI ownership。
- 不做视觉大改；先确保结构、权限和动作归属明确。

完成条件：没有一个核心动作需要靠“这个按钮其实在另外一个 surface 也能做”来解释。

### P0.2 — 拆除跨域万能 Workbench

当前 `MaterialScriptWorkbench` 同时承担 takes / script / review，是 Product Recovery 的核心切除对象。

目标结构：

```text
MaterialWorkspace
ScriptWorkspace
TimelineWorkspace
ReviewWorkspace
```

要求：

- 保留 `TakeCard / TakeListRow / ScriptBlock / MediaCard / SlateRow / PersonRow` 等 canonical renderer；
- 不复制对象 renderer；
- 分离 workspace orchestration、selection state、toolbar、drawer 和写权限；
- 不再使用 `surface="takes|script|review"` 或同义 mode 把多个一级工作区塞回一个组件；
- 迁移一个 consumer 就删除一个失去 owner 的旧 CSS / contract / route 分支。

完成条件：Material / Script / Review 可以分别读懂源码和运行时行为，不需要追踪同一个超级组件的大量条件分支。

### P0.3 — 素材恢复到“资产与拍摄事实中心”

优先完成一个可用 Material happy path：

- 场记 Table 正常占据主画布；
- 素材库、Take、人物作为同一 Material workspace 的 view / task；
- Take 能清楚展示机位、拍摄事实、素材可用性、当前剧本归属摘要；
- relink / 本机素材修复是 contextual tool；
- 批量整理/归集不占用主画布；
- 从 Take 可直接“在剧本中打开”“在审阅中打开”“在时间线中打开”。

禁止：Final Editorial Decision、Timeline edit 控制、完整 Script workspace 混入 Material。

完成条件：剪辑人员能从真实素材快速找到并理解一个 Take，而不是先理解镜序的数据模型。

### P0.4 — 剧本恢复到 Script-first 工作区

- Script / ScriptBlock 是 Primary Canvas；
- 集 / 场 / 搜索等导航只服务剧本扫描；
- 选中 ScriptBlock 后显示当前已归集 Take、候选 Take 与必要证据；
- App 内 Review placement / mapping 修正以 Script workspace 为主家；
- Coverage 收为同一 Script 上下文的 `正常 / 覆盖 / 问题` 等 projection；
- Take picker / detail 使用 drawer / Inspector，不常驻完整素材池第二工作台；
- placement 写入继续遵守 ReviewStore revision / actor / authority contract。

完成条件：用户可以从“这一段剧本缺什么”直接找到候选并完成人工归集，不离开剧本主上下文。

### P0.5 — 时间线恢复到唯一剪辑中心

- `TimelineWorkbench` / Rust Timeline Core 保持唯一 authoritative local editor；
- 检查 source browser、program monitor、tracks、selection、undo/redo、persistence 的主路径；
- rough-cut / assembly / AI editing 只形成 proposal / preview；
- 人工确认后才转换成 Timeline commands；
- Delivery / export 是 Timeline 完成后的 flow，不建立第二 editor；
- 从 Material / Script / Review deep-link 到 Timeline 时保留当前 Take / clip context。

完成条件：用户知道“真正剪片只在这里发生”，其它地方的剪辑相关结果都是候选或入口。

### P0.6 — 审阅恢复到“看片 + 人工决定”

- Viewer / playback 是第一优先级；
- 当前 Take、机位、必要剧本上下文清楚；
- Best / Keep / Reject / Final Editorial Decision 明确可操作；
- “需关注”只做 filter / queue；
- 团队意见、stale evidence、问题原因放 Inspector / context；
- 不在 Review 复制场记编辑、素材 relink、人物治理、批量归集或 Timeline edit；
- 需要修 placement 时“在剧本中打开”，需要修素材时“在素材中打开”。

完成条件：看片和决定不被制作治理按钮、映射工具或二级工作台干扰。

### P0.7 — 统一跨工作区 Project Context

当前跨页状态不能继续靠各 feature 私有 `selectedGroupId / reviewReturn / focus...` 零散传递。

建立最小 typed navigation intent / project selection context，至少支持：

```text
project
Take / group
clip / media
episode / scene / ScriptBlock
Timeline item / source clip
return intent（仅在确有用户价值时）
```

要求：

- context 只保存 selection / intent，不成为业务 truth；
- deep-link 能定位对象，但不能绕过对应 workspace authority；
- 切工作区后不要求用户重新搜索同一个对象；
- resume state 只保存 canonical workspace/view，不恢复废弃 Workbench。

### P0.8 — Product contract 与 authority gate 收口

在功能结构稳定之后再统一调整 contract：

- product surface contract 锁定四 workspace；
- UI authority gate 禁止跨域万能 Workbench 回流；
- canonical renderer ownership 不回退；
- stale source-shape tests 改成真正的产品/authority contract；
- 删除只为了旧实现形状存在的测试，不删除真正的行为红线；
- 修复当前已知 CI red：Python stale navigation contract、compact Take CSS 双 owner。

不要在每个中间微调上手动反复跑 CI；功能切片完成后执行必要的 targeted check，阶段收口再做完整验证。

### P0.9 — 真实项目可用性验收

使用真实《在制项目》或同等规模真实项目做桌面真机测试，不以 fixture UI 截图替代。

至少验证：

- 项目恢复与切换；
- 大量 Take 的查找与滚动；
- 多机位信息是否可读；
- 场记 → 素材 → 剧本 → 审阅 → 时间线的连续对象上下文；
- placement revision 冲突提示；
- Viewer / media binding；
- Timeline source 与编辑主链；
- macOS 1280 / 常用宽屏窗口尺寸；
- light/dark；
- 外部文件拖拽与 NLE 入口。

Swift V1 只作为最低可用性对照：新版本不要求视觉复刻，但核心任务不能更绕、更难找、更容易丢对象。

P0 关闭条件：五步核心工作流真机可用 + 必要自动 gate 在目标 commit 上真实通过。

## P1 — Engineering cleanup

### Desktop CSS ownership consolidation

- `desktop/src/main.tsx` 仍加载多层 base/theme/recovery/redesign/feature CSS。
- Product Recovery 中只删除失去 owner 的样式；P0 稳定后再系统收缩全局 CSS 层。
- 不要机械合并所有 CSS，也不要破坏 canonical component 的 feature-local anatomy ownership。

### Web legacy compatibility DOM

- `web/index.html` 仍保留供 legacy vanilla JS 使用的隐藏 DOM/state 结构。
- 先映射 ID/class consumer，再把状态与事件迁到直接 API/state；只有零 consumer 后才删除隐藏 DOM。

## P2

### Migration-era naming cleanup

- `Golden*`、`*_v2`、`*_v3`、`recovery`、`redesign`、`frozen` 中既有真实实现，也有 compatibility facade。
- 先确认 canonical implementation 与 caller，再迁移 import/name；禁止按文件名批量删除。

### Program Monitor A/V clock and audio monitoring

- Timeline 已有 audio-track authority 和 Delivery 音频语义，但实时 Program Monitor 仍需统一 video/audio playback clock。
- 平台能力不足时保持明确降级，不伪装 sample-accurate NLE playback。

### Source browser scalability

- 大项目需要 Take 分组、搜索和 camera / episode / scene filter。
- 筛选只改变浏览体验，不复制 Review Best/Keep/Reject，也不获得 Timeline authority。

### First Python package migration slice

- 长期边界见 [`../architecture/python-package-boundaries.md`](../architecture/python-package-boundaries.md)。
- 首选 slice 仍是 FCPXML adapter；迁移必须保持业务行为、authority、packaging 和 Desktop staging contract 不变。

### Validation ergonomics

- 记录 python/fast/full gate 的典型耗时和失败分类。
- 如果 fast gate 过慢，应拆分可解释的 smoke 层，而不是静默跳过必要检查。

## P3 / Experimental

### Automated music scoring

- 明确音乐来源/版权、生成模型、候选评分、缓存与人工确认 contract 后再进入 Production。

### Automatic editing engines

- 素材挑选、粗剪、音乐适配等输出保持 proposal/read-only preview；人工确认后才转换成 Rust Timeline commands。

## Backlog 规则

- P0 Product Recovery 期间，任何新功能先证明不会增加新的 workspace / authority / workflow 分叉。
- 条目描述问题、owner、完成条件和红线；不以“多写一层 abstraction”作为默认解决方案。
- 已成为长期约束的内容进入 `DECISIONS.md` / `INVARIANTS.md`。
- 已完成阶段从当前 backlog 删除；Git 历史保存过程。
