# MirrorOrder UI / UX Principles

镜序是后期制作工具，不是 AI 控制台。界面的首要目标是让用户快速理解当前制作对象、进度、异常和下一步操作；技术实现只在需要诊断时出现。

产品定义与 App 信息架构见 `docs/app-information-architecture.md`，Desktop 跨层边界见 `docs/architecture/desktop-bridge.md`，Review/Editorial 协作语义见 `docs/review-read-model.md`，电子场记见 `docs/electronic-script-supervisor.md`。如果旧 README、历史“工作台”文案或兼容层代码与这些当前产品文档冲突，以当前 authority 为准。

## Product surfaces

### App — Production

App 面向真正制作项目的人，负责：

- 新建、打开、归档和删除项目
- 素材目录与本机媒体绑定
- 同步、转写、剧本归集与重新分析
- 内容、人物与声纹等可选增强
- 电子场记与人工拍摄事实
- Coverage、粗剪、组接等制作准备
- 本地模型、运行时和诊断
- Final Cut Pro / Premiere / Resolve 等制作输出

项目是 App 的一级对象。Workspace 是底层隔离概念，不作为日常一级导航。

项目常驻 App 左侧栏。选择项目后中央区域直接进入项目 Production，不再使用“中央项目列表 + 右侧重复 Inspector”作为日常中转页。

后台任务统一进入“状态中心”；项目画布只显示必要的轻量进度，不把同步、ASR、VLM、Audit 等任务模块变成一级导航。

项目 Production 只保留四个一级工作区：

- **素材**：场记 / 素材库 / Take / 人物是同一素材域中的 view / task；
- **剧本**：Script 是主画布，Coverage 是剧本内部 projection；
- **时间线**：唯一 authoritative editor；粗剪、组接、AI editing 属于 Timeline proposal / preparation；交付是输出 flow；
- **审阅**：看片与 Editorial Decision；“需关注”是 filter / queue，不是独立页面。

内部工程模块原则上只能成为 view、filter、contextual tool 或设置项。一个能力只有在产生新的稳定用户工作类型时才应拥有新页面。

### Web — Review / Collaboration

Web 面向团队审阅者，只承担其权限内的：

- 选择项目与集数
- 查看剧本和候选 Take
- 播放与切换机位
- Individual Opinion / 评论
- 受限人工归集修正
- 搜索、人物上下文、场记上下文和分析建议
- 团队意见与协作

Web 不暴露项目创建、本机素材目录、电子场记编辑、本地模型、FFmpeg、Gateway、端口、运行时、Production task 控制、Timeline authority 或 Final Editorial Decision。

## Workflow hierarchy

1. **一个功能只有一个明确的“家”**。其它工作区只能提供 read-only context、快捷入口或携带当前 selection 的 deep-link。
2. **共享对象，不共享工作流**。`TakeRow / MediaCard / ScriptBlock / SlateRow / PersonRow` 等对象 renderer 可以复用；Material / Script / Timeline / Review orchestration 不合并成万能 Workbench。
3. 页面代表新的工作类型；Coverage、Attention、Overview、Binding、Audit、AI Matching、Rough Cut、Assembly 等能力若只是同一对象的 view/filter/tool/state，就必须依附已有对象。
4. 高频动作直接显示；低频、危险和系统级动作放入 `…` 菜单、drawer 或设置。
5. 永久删除永远不是列表行常驻按钮。
6. 项目状态和需关注项是两个维度：一个项目可以同时“已整理”且“有 18 项需关注”。
7. 可选增强不伪装成主处理流水线的必经步骤。
8. 普通制作界面使用制作语言：素材、Take、剧本、场记、人物、时间线、同步、转写。模型名、embedding、runtime、API revision 等实现术语只进入高级设置或诊断。
9. 高频专门任务可以独占中央画布；电子场记就是这种任务，不应寄生在 Take 折叠详情里。
10. Inspector 解释当前选择，不成为第二套导航。Drawer / overlay 承担临时工具，不长期切碎 Primary Canvas。
11. 跨工作区跳转必须尽量保留 project / Take / ScriptBlock / Timeline item 上下文；不能让用户每次跳转后重新寻找同一对象。
12. 普通读操作必须保持轻量。GET、打开页面、切换项目/素材、展开 Inspector 不得隐式触发全盘素材扫描、长时 FFmpeg 解码、模型下载/加载、整项目索引或其它可持续数秒以上的派生重建；昂贵工作必须由明确动作提交为 durable background task，进入状态中心并支持进度、失败、取消/重试。
13. 可重建派生缓存不等于可以在读请求中随意写入。若一次刷新需要真实计算或磁盘遍历，应进入后台任务；只有有界、近似常数成本的轻量状态投影可以在读取时即时计算。

## Workspace interaction model

### 素材

素材主画布用于理解和治理媒体、Take、场记与人物上下文。

- 场记是高密度 Table；
- 素材库 / Take 可以是 list/grid view；
- 人物是素材上下文，不是另一套全局应用；
- relink / 本机素材修复 / 批量整理属于 contextual tool；
- 素材页不拥有 Final Editorial Decision 或 Timeline 编辑器。

### 剧本

剧本主画布是 Script。

- ScriptBlock 是主要扫描对象；
- 当前段/场景的候选 Take 用 drawer / Inspector / picker 展示；
- Review placement 的 App 主入口在剧本工作区；
- Coverage 是同一 Script 上下文的视觉 projection；
- 不永久并排一个完整“素材池工作台”与另一个完整 Inspector 来压缩剧本正文。

### 时间线

时间线是唯一 authoritative editor surface。

- Source browser / proposal / rough assembly 只向 Timeline 提供候选或预览；
- 只有显式人工确认才能转成 Timeline command；
- Delivery 是输出流程，不建立第二套剪辑 state；
- Program Monitor、source viewer、inspector 可以组成专业 NLE 布局，但不得复制 Timeline authority。

### 审阅

审阅优先保证 Viewer + 当前 Take + 人工决定可用。

- Best / Keep / Reject / Final Editorial Decision 是明确人工操作；
- “需关注”只是 queue / filter；
- 团队意见与 evidence 进入 Inspector/context；
- 不复制素材治理、场记编辑、人物管理、批量归集或 Timeline edit 控制；
- 需要改剧本 placement、素材事实或时间线时，使用“在剧本 / 素材 / 时间线中打开”。

## Review / Attention

“需关注”允许聚合：

- Review issue；
- Audit / analysis stale；
- mapping stale；
- 尚未形成有效归集；
- Team Web 的未裁决意见、最终决定之后的新意见或意见分歧。

Attention ranking 只是排序和提示，不产生新的 authority。切换“需关注”不能自动修改人工归集、Individual Opinion 或 Final Editorial Decision。

当前 Take 的原因在 Inspector 内解释；不另开 Attention Workbench。

旧 Overview 的价值只保留为项目/项目行轻量 summary，例如未归集、剧本缺口、需关注和决定完成度；不能复制完整 Review Dashboard 或第二套决定入口。

## Electronic Script Supervisor

电子场记视觉上是一张真实的高密度场记表，而不是卡片式设置面板。

- 一行代表一次实际拍摄记录。
- 素材列使用紧凑视频卡，可挂多机位或单条辅助素材。
- 场、镜、次、状态、范围和备注应支持键盘连续录入。
- Take 自动分组只是场记录入捷径，不是场记记录身份。
- 文件名搜索和 Finder 拖入属于正式录入方式。
- 自然语言/语音只负责解析字段，保存前仍落到明确人类记录。
- “前半段”“后半段”等自然语言不能被 AI 猜成具体秒数。
- 场记人工景别比同 clip 的 AI 景别更可信，但不能传播到其它机位。
- 场记状态不等于 Editorial Decision；NG 不是 Delivery Reject。

## Canonical production objects

同一个制作对象在同一 Product Surface 内必须只有一个 canonical renderer。

当前核心对象包括：

- Slate Row；
- Take Card / compact Take Row；
- Media Card；
- Script Block；
- Identity Candidate Row / Person Row；
- Timeline objects。

页面只组合这些对象或适配数据。Workspace、theme、redesign、feature CSS 不得重新声明 canonical 对象的核心 anatomy、固定 geometry、slot 顺序或 selection geometry。

组件自己的 stylesheet 是其 anatomy owner；workspace stylesheet 只负责 pane/grid/context layout。迁移到 canonical component 后，旧 page/theme selector 必须同步删除，不能保留“备用覆盖”。

## Visual language

- 采用 macOS / 专业后期工具式的中性 graphite 表面。
- Accent color 用于选择和主要操作，不作为装饰色铺满界面。
- 颜色只表达语义：蓝色选择/进行中，绿色完成，黄色人工注意，红色失败/危险，灰色普通信息。
- 优先使用 Pane、Divider、List、Table、Inspector；避免 Card、Pill、Badge 到处堆叠。
- 时间码、媒体 ID、路径等技术信息可使用等宽数字/字体；普通标题和正文使用系统字体。
- 不使用 sparkles 等泛 AI 图标作为主要导航语言；功能使用具体对象图标。
- 大画布必须被真实生产信息占用；不能为了“留白高级感”让核心工作区只占窗口很小一块。
- 同一屏不要用多层标题、面包屑、tab 和重复 context 文案反复告诉用户“你在哪里”。

## Density

专业不等于拥挤。默认界面应高信息密度但低视觉噪音：

- 列表行展示名称、制作状态、需关注项和少量关键计数。
- 详细证据、日志和高级控制进入 Inspector / Disclosure / Settings。
- 同一信息不在列表、Inspector 和弹窗重复完整展示。
- 项目左栏保持紧凑；项目详情不再重复占据中央与右侧。
- 电子场记以 Table 为主，预览按需浮出，不长期抢占录入宽度。

## Web responsive behavior

- `> 1260px`：剧本 / Take / Viewer 三栏可以作为 Team Web 审阅布局；
- `901–1260px`：剧本 + Take，Viewer 移至下方；
- `<= 900px`：单栏审阅流，优先保证播放器与决策可用；
- `<= 680px`：Take 纵向排列，工具栏允许横向滚动，不能要求 1500px 固定画布。

这些 Web responsive 规则不意味着 Desktop Production 四个 workspace 应复用同一个三栏审阅 Workbench。

## Review semantics

分析建议不能直接成为人工审核结论。团队协作区分：

- Individual Opinion：某位审核者的 Best / Keep / Reject 与评论；
- Editorial Decision：最终权威决定。

自动分析可以提供证据和建议，但不能静默覆盖人工意见或最终决定。

电子场记属于第三类人工事实：它描述现场拍摄、景别、可用范围和制作备注，但本身也不是 Editorial Decision。

## Usability regression rule

历史 Swift V1 不再决定当前视觉或技术实现，但其核心任务可用性是最低回归基线。

真实项目上必须顺畅完成：找到 Take → 理解拍摄事实/归属 → 修正剧本 placement → 看片决定 → 带入 Timeline。若新版需要更多无意义导航层、丢失当前对象或让用户无法判断在哪完成动作，即使自动测试通过，也属于产品回归。
