# App Product Experience Architecture

> 当前产品体验与产品定义 authority：2026-09-05。
>
> 本文同时定义“镜序是什么”和 Desktop Production 应如何组织。当前 Desktop 开发入口见 [`../desktop/README.md`](../desktop/README.md)，视觉与交互规则见 [`ux-principles.md`](./ux-principles.md) 与 [`design-system-v2.md`](./design-system-v2.md)，跨层技术边界见 [`architecture/desktop-bridge.md`](./architecture/desktop-bridge.md)。如果历史 README、旧 Workbench、兼容 route 或实现细节与本文冲突，以本文为产品 authority。

## 0. 镜序产品定义

### 0.1 镜序解决什么问题

镜序（MirrorOrder）是面向短剧与多机位后期整理的本地优先 Production 工具。

它的核心任务不是“展示所有 AI / 媒体 / 审阅 / 剪辑能力”，而是把真实后期最费时间的一条链压缩得可靠、清楚、可人工控制：

```text
混乱的原始素材 + 剧本 + 可选场记
        ↓
识别真实拍摄 Take 与多机位关系
        ↓
记录 / 修正拍摄事实
        ↓
把 Take 对到正确剧本位置
        ↓
看片并做人工判断
        ↓
形成可剪的 Timeline 结构
        ↓
进入 FCP / Premiere / Resolve 或完成交付
```

镜序的价值首先是**减少剪辑人员在“找素材、认素材、对剧本、看片判断、组织成可剪结构”之间来回切换和重复确认的成本**。

### 0.2 主用户工作，不是模块目录

用户打开一个项目后，应始终围绕当前制作对象继续工作，而不是浏览功能目录。

核心工作只有四类：

1. **素材** — 我拿到了什么？实际拍了什么？素材与 Take 的拍摄事实是什么？
2. **剧本** — 这些 Take 对应故事哪里？哪里还缺、哪里有冲突？
3. **时间线** — 当前可剪结构和成片结构是什么？
4. **审阅** — 哪些内容需要我看片并作人工决定？

Desktop 项目内的四个一级工作区固定为：

```text
素材 / 剧本 / 时间线 / 审阅
```

不再按代码模块、算法、read model 或内部 store 数量增长一级产品面。

### 0.3 AI 在镜序里的位置

AI、Audit、语义检索、人物/声纹识别、小镜、自动归集、粗剪建议都属于**证据或提案能力**，不是新的业务权威，也不是独立的主工作流。

统一权限链：

```text
evidence → proposal → human confirmation → authority
```

自动结果不得静默成为 Review placement、Final Editorial Decision 或 Timeline authority。

### 0.4 四类人工事实必须分开

```text
场记 / Slate fact        = 现场拍了什么、场镜次、备注、可用范围等拍摄事实
Review placement         = Take 对应剧本哪里
Editorial Decision       = Take 最后 Best / Keep / Reject 等人工剪辑判断
Timeline authority       = 最终本机剪辑结构
```

它们可以互相投影上下文和证据，但不能因为 UI 便利而静默互相改写。

### 0.5 最低可用性验收

在真实项目上，以下五件事必须形成连续、清楚、无需猜导航的 happy path：

1. 找到一个实际 Take；
2. 看懂它的拍摄事实、机位和当前归属；
3. 把它修正到正确剧本位置；
4. 看片并完成需要的人工决定；
5. 把需要的素材 / 决定组接并导出到外部 NLE 继续剪。

这五步未顺畅完成前，Desktop Product Recovery 不得以“功能齐全”“contract 很多”“组件复用率高”视为可用。

历史 Swift V1 不再是实现或视觉 authority，但它仍是**最低可用性回归基线**：对于上述核心任务，新 Desktop 不应比 Swift V1 更难理解、需要更多无意义导航层级或更容易丢失当前对象。

### 0.6 明确非目标

镜序不是：

- Host / Workspace launcher；
- AI 模型控制台；
- 每个算法一个页面的模块 Dashboard；
- 第二套 NLE；
- 为了“统一组件”把不同用户工作塞进万能 Workbench 的框架展示；
- 用前端本地状态复制 Review / Editorial / Timeline truth 的系统。

## 1. 启动与恢复

只记住**成功打开过的本机工作区**。Tauri 启动后：

1. 尝试恢复上次成功工作区；
2. 恢复上次项目；
3. 恢复该项目上次离开的 Production 工作区 / 视图；
4. 没有页面历史的新项目默认进入 **素材 → 场记**。

App 不允许用 `projects[0]` 作为隐式产品默认。

历史页面恢复必须 canonicalize：

- `rough-cut / assembly` → `timeline`；
- `attention / overview` → `review/watch`；
- `coverage` → `script` 的 Coverage view。

这些名称只保留兼容含义，不代表它们仍拥有独立 Workbench。

恢复失败时停在低噪声恢复页，只提供重新定位工作区、打开其它工作区和清除自动恢复记录。Host 地址、端口和“连接已运行服务”只进入高级连接 disclosure。

## 2. 全局 App 壳层

打开工作区后，App 为全高 Production frame：

```text
┌──────────── Global Sidebar ────────────┬──────────────── Production Canvas ────────────────┐
│ 镜序                                  │ 项目 Toolbar                                      │
│                                       │ 素材 / 剧本 / 时间线 / 审阅                       │
│ 项目                                  │ 当前工作区的 view / filter / contextual tool       │
│ · 项目 A                              │                                                    │
│ · 项目 B                              │                 Primary Canvas                     │
│ · 项目 C                              │                                                    │
│                                       │                                      小镜 Drawer → │
│ 状态中心                              │                                                    │
│ 团队审阅                              │                                                    │
│ 设置                                  │                                                    │
│ ───────────────────────────────────   │                                                    │
│ 工作区 · 已就绪 ▾                     │                                                    │
└───────────────────────────────────────┴────────────────────────────────────────────────────┘
```

### Sidebar

Sidebar 只承担长期上下文与全局工具：镜序品牌、项目列表、新建项目、状态中心、团队审阅、设置和底部工作区 disclosure。

项目行只展示项目名、轻量 Take / 素材摘要、需关注摘要、当前后台活动或明确错误。路径、端口、模型名称、API revision 和后台日志不得常驻 Sidebar。

Workspace 是底层隔离概念，不是日常一级产品对象。

## 3. 四个 Production 工作区

### 3.1 素材

素材回答：

> 我拿到了什么？实际拍了什么？这些媒体、Take、人物和场记事实是否清楚？

素材域允许的正式 view / task：

- **场记** — 电子场记 Table；一行代表一次实际拍摄记录；
- **素材库** — Media / clip 浏览、本机可用性与来源；
- **Take** — 逻辑 Take 与多机位关系；
- **人物** — 人物/声纹等素材上下文。

这些是同一素材域中的不同视图和专门任务，不应各自成长为带独立导航、独立状态系统和独立对象 renderer 的平行应用。

`本机素材 / 换素材盘 / relink` 是素材关联的修复工具；批量整理/归集属于明确的素材治理工具。它们不是一级工作区。

素材工作区不拥有 Final Editorial Decision，也不编辑 Timeline authority。

### 3.2 剧本

剧本回答：

> 这些 Take 对应故事哪里？哪些段已有可靠素材，哪些缺失或冲突？

剧本正文 / ScriptBlock 是 Primary Canvas。

Take 以当前剧本段、场景或集数的候选 / 已归集上下文出现，可以通过 Inspector / drawer / picker 选择和修正 placement，但不建立第二套素材库工作台。

Coverage 是剧本的**显示模式 / projection**，例如：

```text
正常 / 覆盖 / 问题
```

Coverage 不拥有独立 Workbench，也不能成为新的 placement authority。

App 内“Take 对应剧本哪里”的人工修正以剧本工作区为主家。其它工作区需要修改 placement 时，应携带当前对象跳转到剧本，而不是复制同一套归集控制器。

### 3.3 时间线

时间线回答：

> 当前组接结果和成片结构是什么？

Rust Timeline Core 是唯一 authoritative local timeline edit state。Desktop 时间线是唯一正式剪辑版本的呈现与核对 surface。

镜序自身不承担帧级精剪（owner 2026-10-26 决策）。时间线工作区 = 初始顺片组接 + 只读核对（含 Source/节目监看）+ 换镜次与多机位决定 + 交付 / 导出；切分、修剪、移动、波纹删除、手工插入 / 覆盖等帧级操作不在镜序内提供，导出到外部 NLE 后继续。初始顺片与换镜次等写操作仍经 command bridge 写入 Rust Timeline Core，不建立第二套编辑状态。

粗剪、组接、AI editing、场记约束、Coverage 建议都只能形成 proposal / preparation / preview：

```text
proposal → preview → human confirmation → Timeline commands
```

历史 `rough-cut / assembly` 不再拥有第二套编辑器或第二套状态。

交付 / 导出是时间线的主终点动作（Primary action），可以拥有专门 modal、drawer 或流程页，但不得与 Timeline 形成竞争性的剪辑 authority。

### 3.4 审阅

审阅回答：

> 哪些内容需要我看片并作人工判断？

本地审阅的正式 Production surface 是看片，核心包括：

- Viewer / 播放与机位切换；
- 当前 Take 与必要剧本上下文；
- Best / Keep / Reject / Final Editorial Decision 等人工判断；
- 评论、团队意见和协作投影；
- **需关注** queue / filter。

“需关注”聚合问题、stale evidence、未形成有效归集和待裁决团队意见，但筛选与排序本身不产生 authority。

审阅不复制素材治理、场记编辑、人物管理、批量归集或 Timeline 编辑器。需要修改剧本 placement、素材事实或时间线时，使用“在剧本 / 素材 / 时间线中打开”，并保留当前对象上下文。

Team Web 仍是独立 Review / Collaboration surface，可按其权限契约提供团队人工归集和 Individual Opinion；它不获得本机素材、Production Slate、Final Editorial Decision 或 Timeline authority。

## 4. 共享对象，不共享工作流

Desktop 的复用单位是**制作对象 renderer 和基础交互 primitive**，不是跨域工作流。

可以共享：

- TakeCard / TakeListRow；
- MediaCard；
- ScriptBlock；
- SlateRow；
- Identity Candidate / Person Row；
- Viewer / Inspector primitives；
- 通用 filter、selection、drawer 基础设施。

不应共享为一个万能 Workspace：

```text
MaterialWorkspace
ScriptWorkspace
TimelineWorkspace
ReviewWorkspace
```

必须分别拥有各自的 orchestration、主要动作和写权限。

禁止通过一个大型 Workbench 的 `surface="takes|script|review"`、`mode` 或同类条件分支来同时承担多个一级工作区。这样会把导航、状态、权限和视觉层级重新揉成一套不可理解的超级组件。

跨工作区复用应通过：

1. canonical object renderer；
2. typed project context / selection intent；
3. 明确 deep-link / “在…中打开”；
4. Core read model / command contract。

## 5. Primary Canvas 与 Contextual Tools

每个工作区必须只有一个明确 Primary Canvas。Inspector 解释当前选择，不成为第二套导航；drawer / overlay 只承载临时上下文工具，不永久把主画布切碎成三四个互相抢焦点的列。

### 小镜

小镜是右侧 contextual drawer。它提供解释、证据和 proposal，不拥有业务 authority，也不成为独立页面。

### 语义搜索

项目级搜索使用 `⌘K / Ctrl+K`。结果提供 retrieval evidence / ranking，不成为 Review、Editorial 或 Timeline authority。

## 6. 全局工具

### 状态中心

所有 durable background task 统一进入状态中心：同步、转写、匹配、内容识别、人物/声纹、Audit、语义索引和其它长任务。

Production Canvas 只展示轻量进度/失败提示，不复制完整任务控制器。Status Center 是 project/device durable task 的唯一全局控制面。

### 设置

设置是全局工具，不是 Production Workspace。

### 团队审阅

团队审阅是独立协作 surface，不属于本地审阅 workspace 的第二套页面树。其权限以 Review / Collaboration contract 为准。

## 7. 新建项目

新建项目是低频流程：

- Sidebar 常态只显示“新建”；
- 点击后进入聚焦 modal；
- 主文案使用“检查 / 创建 / 后台整理”等用户语言；
- `WorkspaceRegistry`、`prepare_project`、task id 等实现细节不进入正常流程；
- 新项目成功后进入 **素材 → 场记**。

## 8. 视觉与交互纪律

- 系统字体 / PingFang SC；
- 中性色为主，小圆角；
- 高密度 Table / List / Split View / Inspector；
- 清晰 selected state；
- Toolbar 不堆永久按钮；
- 主工作区不使用 KPI Dashboard、大卡片瀑布流、大面积渐变或 AI 发光视觉；
- 大画布必须被当前生产对象占用；
- 技术 ID、API revision、模型实现只在诊断需要时出现；
- 页面不得重复告诉用户“你在哪里”，导航层级以完成任务所需的最小层级为准。

## 9. Product Recovery 红线

当前 Desktop 进入 Product Recovery 时，优先级是**恢复可用主链**，不是继续扩展能力。

在第 0.5 节五项核心任务形成真实可用 happy path 前：

- 不新增一级工作区；
- 不新增新的万能 Workbench；
- 不通过 CSS 隐藏结构问题；
- 不为追求抽象一致性跨越 Slate / Review / Editorial / Timeline authority；
- 不把测试绿灯当作可用性验收；
- 不恢复 `Coverage / Attention / Overview / Rough Cut / Assembly` 为平级主页面；
- 不让工程模块数量决定导航数量。
