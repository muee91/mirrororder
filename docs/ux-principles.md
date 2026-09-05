# MirrorOrder UI / UX Principles

镜序是后期制作工具，不是 AI 控制台。界面的首要目标是让用户快速理解当前制作对象、进度、异常和下一步操作；技术实现只在需要诊断时出现。

App 信息架构见 `docs/app-information-architecture.md`，Desktop 跨层边界见 `docs/architecture/desktop-bridge.md`，Review/Editorial 协作语义见 `docs/review-read-model.md`，电子场记见 `docs/electronic-script-supervisor.md`。如果旧 README、历史“工作台”文案或兼容层代码与这些当前产品文档冲突，以当前 authority 为准。

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
- Final Cut Pro 等制作输出

项目是 App 的一级对象。工作区 / Workspace 是底层隔离概念，不作为日常一级导航。

项目常驻 App 左侧栏。选择项目后中央区域直接进入项目工作区，不再使用“中央项目列表 + 右侧重复 Inspector”作为日常中转页。

后台任务统一进入“状态中心”；项目画布只显示必要的轻量进度，不把同步、ASR、VLM、Audit 等任务模块变成一级导航。

项目 Production 只保留四个一级工作区：

- 素材：场记 / 素材库 / Take / 人物
- 剧本：剧本；Coverage 是剧本内部覆盖视图
- 剪辑：Timeline / 交付；粗剪与组接属于 Timeline proposal / preparation 语义
- 审阅：看片；“需关注”是看片 filter，不是独立页面

项目首页负责轻量 production summary，例如 Take / 素材、未归集、剧本缺口、需关注和决定完成度；它不恢复独立 Overview Dashboard。

内部工程模块原则上只能成为二级功能、view/filter 或设置项。一个能力只有在产生新的用户工作类型时才应拥有新页面。

### Web — Review

Web 面向团队审阅者，只承担：

- 选择项目与集数
- 查看剧本和候选 Take
- 播放与切换机位
- Best / Keep / Reject 等个人审核意见
- 人工归集修正
- 搜索、人物上下文、场记上下文和分析建议
- 团队意见与协作

Web 不暴露项目创建、素材目录、电子场记编辑、本地模型、FFmpeg、Gateway、端口、运行时或生产任务控制。

## Interaction hierarchy

1. 一个功能只有一个明确的“家”。上下文菜单可以提供快捷方式，但不能形成第二套控制中心。
2. 页面代表新的工作类型；Coverage、Attention、Overview、Binding、Audit、AI Matching 等能力若只是同一对象的 view/filter/tool/state，就必须依附已有对象，而不是扩张导航。
3. 高频动作直接显示；低频、危险和系统级动作放入 `…` 菜单或设置。
4. 永久删除永远不是列表行常驻按钮。
5. 项目状态和需关注项是两个维度：一个项目可以同时“已整理”且“有 18 项需关注”。
6. 可选增强不伪装成主处理流水线的必经步骤。
7. 普通制作界面使用制作语言：素材、Take、剧本、场记、人物、同步、转写。模型名、embedding、runtime、API revision 等实现术语只进入高级设置或诊断。
8. 功能增长优先进入已有一级工作区的二级入口、filter、Inspector 或 view，不按代码模块数量增长导航数量。
9. 高频专门任务可以独占中央画布；电子场记就是这种任务，不应寄生在 Take 折叠详情里。
10. 普通读操作必须保持轻量。GET、打开页面、切换项目/素材、展开 Inspector 不得隐式触发全盘素材扫描、长时 FFmpeg 解码、模型下载/加载、整项目索引或其它可持续数秒以上的派生重建；昂贵工作必须由明确动作提交为 durable background task，进入状态中心并支持进度、失败、取消/重试。读面只消费已有派生结果、缓存和任务状态，不因为“缓存缺失”就偷偷把读请求升级成重计算。
11. 可重建派生缓存不等于可以在读请求中随意写入。若一次刷新需要真实计算或磁盘遍历，应进入后台任务；只有有界、近似常数成本的轻量状态投影可以在读取时即时计算。

## Review / Attention

本地审阅只有一个 Production surface：**看片**。

“需关注”是看片的统一 queue/filter，允许把以下 read-model evidence 聚合到同一筛选：

- Review issue；
- Audit / analysis stale；
- mapping stale；
- 尚未形成有效归集；
- Team Web 的未裁决意见、最终决定之后的新意见或意见分歧。

Attention ranking 只是排序和提示，不产生新的 authority。切换“需关注”不能自动修改人工归集、Individual Opinion 或 Final Editorial Decision。

当前 Take 的原因在 Inspector 内解释；不另开 Attention Workbench。

旧 Overview 的价值只保留为项目首页的轻量 summary。项目首页可以显示未归集、剧本缺口、需关注和决定完成度，但不能复制一个完整 Review Dashboard，也不能提供第二套决定入口。

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

页面只组合这些对象或适配数据。Workbench、theme、redesign、feature CSS 不得重新声明 canonical 对象的核心 anatomy、固定 geometry、slot 顺序或 selection geometry。

组件自己的 stylesheet 是其 anatomy owner；页面 stylesheet 只负责 pane/grid/context layout。迁移到 canonical component 后，旧 page/theme selector 必须同步删除，不能保留“备用覆盖”。

## Visual language

- 采用 macOS / 专业后期工具式的中性 graphite 表面。
- Accent color 用于选择和主要操作，不作为装饰色铺满界面。
- 颜色只表达语义：
  - 蓝色：选择、进行中
  - 绿色：完成
  - 黄色：需要人工注意
  - 红色：失败、危险操作
  - 灰色：普通信息
- 优先使用 Pane、Divider、List、Table、Inspector；避免 Card、Pill、Badge 到处堆叠。
- 时间码、媒体 ID、路径等技术信息可使用等宽数字/字体；普通标题和正文使用系统字体。
- 不使用 sparkles 等泛 AI 图标作为主要导航语言；功能使用具体对象图标。
- 大画布必须被真实生产信息占用；不能为了“留白高级感”让核心工作区只占窗口很小一块。

## Density

专业不等于拥挤。默认界面应高信息密度但低视觉噪音：

- 列表行展示名称、制作状态、需关注项和少量关键计数。
- 详细证据、日志和高级控制进入 Inspector / Disclosure / Settings。
- 同一信息不在列表、Inspector 和弹窗重复完整展示。
- 项目左栏保持紧凑；项目详情不再重复占据中央与右侧。
- 电子场记以 Table 为主，预览按需浮出，不长期抢占录入宽度。

## Web responsive behavior

- `> 1260px`：剧本 / Take / Viewer 三栏。
- `901–1260px`：剧本 + Take，Viewer 移至下方。
- `<= 900px`：单栏审阅流，优先保证播放器与决策可用。
- `<= 680px`：Take 纵向排列，工具栏允许横向滚动，不能要求 1500px 固定画布。

## Review semantics

分析建议不能直接成为人工审核结论。团队协作区分：

- Individual Opinion：某位审核者的 Best / Keep / Reject 与评论
- Editorial Decision：最终权威决定

自动分析可以提供证据和建议，但不能静默覆盖人工意见或最终决定。

电子场记属于第三类人工事实：它描述现场拍摄、景别、可用范围和制作备注，但本身也不是 Editorial Decision。
