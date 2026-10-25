# MirrorOrder Design System v2 — Professional UI / UX System

> 当前实现位于 `desktop/src/design-system-v2.css` 与 `web/design-system-v2.css`。
>
> Product authority remains `docs/ux-principles.md` and `docs/app-information-architecture.md`.
>
> 本文是 MirrorOrder UI / UX 的执行级设计 authority：定义组件语义、视觉层级、机位识别、状态系统、布局不变量、响应式行为和迁移验收标准。它不是“主题皮肤”，也不是要求所有页面共享一个模板。

## 1. Product posture

MirrorOrder 是专业影视后期 Production 软件，不是 AI Dashboard、模块目录或卡片式管理后台。

设计目标：

1. **制作对象优先**：用户首先看到素材、场记、Take、剧本、时间线、播放器和审阅证据，而不是模型、任务 ID、runtime 或工程模块。
2. **稳定肌肉记忆**：相同语义永远出现在相同位置；不可因为内容长度、窗口宽度、加载状态或缺少某个字段而错列、跳位或改变阅读顺序。
3. **高密度、低噪音**：信息密度来自行高、列宽、Split View、Inspector 和渐进披露，不来自 7–9px 小字。
4. **统一行为，不统一模板**：Focus、Selection、Status、Camera、Toolbar、Inspector、Dialog 等交互语法统一；场记、素材、剧本、审阅、剪辑保留各自专业工作区结构。
5. **人类 authority 清晰**：AI 只提供线索、候选和证据，不用视觉权重伪装成人工决定。
6. **对象 renderer 单一 ownership**：固定 production object 的 anatomy 只能由 canonical component + component stylesheet 定义；Workbench、page、theme、redesign CSS 只能负责上下文布局或 semantic token，不得重新接管对象 geometry。

## 2. Non-negotiable rules

以下规则属于硬约束：

- 普通 Production UI 字号不得低于 `10px`；`7px / 8px` 禁止用于可操作或需要阅读的生产信息。
- 所有可交互控件必须有 `hover / selected / focus-visible / disabled`，涉及编辑或拖拽时再增加 `editing / drag-target / error`。
- `outline: none` 只能和统一 `:focus-visible` 替代方案同时存在。
- Card 只能表示真正独立的对象；Pane / Table / List 不得包装成层层 Card。
- Pill 只能表示短状态、短分类或数量；不能把普通文案都做成 Pill。
- 状态颜色和机位颜色是两套独立 token；机位色绝不能被解释为成功/警告/失败。
- Slate 的 A / B / C / AUX 列是稳定槽位。缺少某机位时保留空槽，不允许后续机位左移补位。
- 同一对象的名称、时间码、机位、状态不得因为 badge 出现或消失而横向跳动。
- optional metadata 应隐藏内容而不是改变核心网格结构。
- 表格列、时间码列、数字列使用稳定宽度与 tabular numerals。
- 可拖拽区域必须有明确抓取对象和明确目标反馈，不能让整个页面都成为模糊 drop zone。
- 危险操作不得作为列表/卡片永久主按钮。
- 同一 Product Surface 内，同一 production object 只能有一个 canonical renderer。
- canonical renderer 的核心 anatomy、固定尺寸、slot 顺序、selection geometry 不得被 page/theme/redesign stylesheet 覆盖。

## 3. Product shell and navigation

### 3.1 Global shell

Global Sidebar 只承载长期上下文与全局功能：

- 镜序品牌 / 首页；
- 项目；
- 当前项目上下文；
- 状态中心；
- 团队审阅；
- 设置；
- 工作区 disclosure。

项目内 Production Area 不应逐个变成 Global Sidebar 一级导航。

### 3.2 Project production hierarchy

项目内保留四个稳定 Area：

- 素材：场记 / 素材库 / Take / 人物；本机素材是隐藏修复工具
- 剧本：剧本；Coverage 是 Script 内部覆盖视图，不是常驻 peer page
- 剪辑：Timeline / 交付；粗剪 / 组接是 Timeline proposal / preparation 语义，不建立第二 editor
- 审阅：看片；“需关注”是 Watch filter，旧“待处理”不再是 Workbench；Overview 摘要进入 Project Home

Area 使用稳定 segmented navigation。只有存在多个正式工作对象时才显示 secondary navigation；view/filter/tool 不为了“看起来对称”而升级为页面。

### 3.3 Toolbar rule

Toolbar 只保留当前工作对象的高频动作。

禁止将“去另一个页面”长期当作 Toolbar 主动作。页面导航应由正式导航承担；Coverage 等对象内 view 可以由 contextual action 打开，但不能因此成为平级产品页。

每个工作区 Toolbar 建议最多：

- 1 个主动作；
- 2–4 个高频 secondary actions；
- 1 个 Inspector / contextual tool toggle；
- 其余进入 `…` / Popover / Inspector。

## 4. Spatial system

### 4.1 Surface hierarchy

从外到内：

1. App Surface
2. Sidebar / Chrome
3. Primary Pane
4. Raised Control / Popover / Dialog
5. Selected / Drag Target / Focus overlay

只允许相邻层级产生明显层次。禁止在 Pane 内反复套带阴影卡片制造“层层盒子”。

### 4.2 Standard geometry

- control radius: `5px`
- pane radius: `0–4px`
- media thumbnail/card radius: `5–6px`
- popover/dialog radius: `8px`
- status pill: `999px`，仅短语义状态
- divider: `1px`

这些是 token / primitive 级参考。若 canonical component 已定义自己的对象 anatomy，页面/theme 不得利用全局 selector 再覆盖它的几何结构。

### 4.3 Split pane

所有多栏专业工作区必须使用明确 Pane：

- 每栏有 `min-width`；
- 允许 resize 时使用持久 divider；
- resize 后保存项目/工作区布局；
- 不能靠内容自然撑宽导致 Inspector 或主表跳动。

### 4.4 Alignment invariants

专业布局必须显式定义网格，不依赖 auto placement：

- 使用 `grid-template-columns` 或 table `colgroup` 固定语义槽位；
- 名称/说明列使用 `minmax(0, 1fr)`；
- status / camera / timecode / count 使用固定或 bounded width；
- optional badge 放在预留 slot 中；
- 文本超长使用 ellipsis / clamp + tooltip；
- 禁止因文本换行把状态指示器推到下一行；
- 断点只能改变“布局模式”，不能在同一模式下随内容随机重排。

## 5. Typography

统一字阶：

- `10px` — tertiary / technical helper，最低可读层级
- `11px` — dense table / toolbar / metadata
- `12px` — normal production copy / forms
- `13px` — strong label / panel heading
- `14–15px` — workspace title
- `17px` — page / major context title

禁止：

- 7px、8px 生产信息；
- 为了塞更多内容缩字体；
- 同一层级在不同 workspace 使用不同字号。

下限收紧（2026-10-26 全工作区走查结论）：

- `10px` 降级为**历史存量**，不再新增；被触碰的表面与新代码一律 `11px` 起，正文保持 `12px`。依据：走查截图中 10px 灰字连视觉模型都会误读，专业工具的最低可读层级必须让人类无歧义。
- 辅助/技术灰字与背景对比度不低于 WCAG AA（正文 4.5:1；大字与图形 3:1）。颜色不能作为唯一识别方式的既有规则不变。

时间码、媒体 ID、clip ID、路径、帧号：

- `ui-monospace / SFMono`
- `font-variant-numeric: tabular-nums`

## 6. Color systems

### 6.1 Semantic status colors

Status 只使用：

- accent blue — selection / active / in-progress
- green — complete / ready / usable
- amber — attention / partial / warning
- red — failure / danger / destructive
- graphite/gray — neutral / inactive / unknown

颜色不能作为唯一识别方式，必须同时有 label、icon、shape 或位置之一。

**状态词汇表（2026-10-26 起为唯一用词，跨工作区不得造同义词）：**

审阅「需关注」分层（计数与筛选都用这三层，实现见 `reviewAttention.ts` 的 tier）：

| 层级 | 词 | 判定 |
|---|---|---|
| 阻断 | `阻断` | issue severity = error |
| 过期 | `证据过期` | analysis/mapping stale |
| 待关注 | `待关注` | 其余（warning / 未归集 / 团队意见） |

媒体可用性口径（服务端声明与本机事实是两层，禁止互相冒充）：

| 口径 | 词 | 来源 |
|---|---|---|
| 机位未拍摄 | `无素材` | 机位槽位无 angle |
| 服务端判定不可用 | `素材离线` | `playback.available === false` |
| 本机加载失败 | `本机播放失败`，细分 `素材缺失 / 解码失败 / 连接失败` | video onError + 一次 Range 探测（`playbackFailure.ts`） |
| 服务端声明可用（未本机验证） | 只能表述为「可用（未验证）」或展示声明来源 | URL 存在不等于可播放 |

历史分叉词（`素材异常` 等）不再使用；发现新分叉时收敛回本表而不是新增。

### 6.2 Camera identity colors

Camera 属于 categorical identity，不属于 status。

固定第一类机位：

| Camera | Label | Token family | Sort | 视觉要求 |
| --- | --- | --- | ---: | --- |
| A | A机 | camera-a / azure | 10 | 永远显示 `A机`，左/上固定 badge |
| B | B机 | camera-b / violet | 20 | 永远显示 `B机` |
| C | C机 | camera-c / teal | 30 | 永远显示 `C机` |
| AUX | AUX | camera-aux / steel | 40 | 辅助/特殊素材，不能伪装成 A/B/C |
| Custom | 原始标签 | camera-custom | 60 | 显示完整短标签 |
| Unknown | 未识别 | camera-unknown | 90 | 明确显示 `? / 未识别` |

Camera identity 需要同时由以下至少两项表达：

- label；
- categorical color；
- slot position；
- optional rail / border marker。

因此色觉异常用户仍能区分机位。

### 6.3 Camera slot invariant

Slate、Take member strip、多机位比较器必须按：

`A → B → C → AUX → Custom`

稳定排序。

当 B 不存在时：

- A 保持 A slot；
- B slot 显示空；
- C 仍在 C slot；
- 禁止 C 左移到 B 的视觉位置。

## 7. Component families

MirrorOrder 不使用一个万能 `Card`。每个对象族必须有独立组件语法。

### 7.1 Media Card

用途：单条 clip / angle / media。

固定结构：

```text
┌──────── Thumbnail ────────┬──────── Metadata ────────┬─ State ─┐
│ [A机]                     │ file name                │    ✓    │
│ frame / preview           │ 景别 · 时长               │         │
│                           │ role / availability      │         │
└───────────────────────────┴───────────────────────────┴─────────┘
```

规则：

- Camera Badge 永远固定 thumbnail 左上；
- Preferred 控件固定右上，出现/隐藏不改变内容网格；
- selected mark 使用预留 state slot，不得把 metadata 挤窄；
- `compact / inspector / grid` 可以改变尺寸，但内部 anatomy 不变；
- media name 最多 2 行；
- shot / duration / role 位置固定；
- unavailable 使用 neutral/danger evidence，不通过整卡大面积变红。

### 7.2 Take Card

用途：一组同步机位 / 一个 Take group。

固定 anatomy：

1. Take identity：`T12 / Scene / duration`
2. Camera member strip：A/B/C/AUX stable slots
3. transcript / dialogue evidence
4. review / placement state
5. actions / selection rail

Take Card 不能直接复用 Media Card 视觉；Media 是成员，Take 是组。

Compact Take Row 与 Take Card 属于同一 Take component family，必须由同一 canonical owner 定义；Slate picker、placement pools 等 consumer 不得用本地 descendant selector 重画 compact Take anatomy。

### 7.3 Slate Row

Slate Row 不是 Card。

固定列：

`Index | Episode | Scene | Shot | Take | A | B | C | AUX | Slate Status`

要求：

- sticky header；
- row height 有统一 baseline；
- selected 使用左 selection rail + restrained background；
- editing cell 只强调当前 cell；
- row status 不改变整个 row 的结构；
- camera cells 使用 Camera Slot，而不是临时塞不同宽度卡片。

### 7.4 Evidence Card

用途：AI/检索/对白/人物/场记来源证据。

视觉优先级低于人类决定：

- neutral border；
- source label；
- evidence content；
- confidence（若有）只作为证据元数据；
- 不使用“AI 紫色发光”或类似 authority 视觉。

### 7.5 Identity Item

用途：人物/声纹/演员候选。

固定 anatomy：

1. portrait / avatar slot；
2. display name + candidate/human authority copy；
3. evidence count / confidence；
4. confirmation state；
5. 人工确认操作在 Inspector，不把危险/低频动作塞进每行。

`IdentityCandidateRow` 与 `PersonRow` 是 canonical Identity row renderer；`IdentityPortrait` 是同一 component family 的固定 portrait slot。

**Style ownership：**

- `IdentityRows.tsx` 负责对象 DOM anatomy；
- `identity-rows.css` 负责 row / copy / meta / portrait geometry、typography、selection 和 responsive anatomy；
- `identity-workbench.css` 只负责列表、Inspector、evidence 和 pane layout；
- app redesign/theme CSS 不得再声明 `.identity-row`、`.identity-row-copy`、`.identity-row-meta`、`.identity-portrait` 的结构规则。

不得将人物候选、已确认人物和“未知人物”只靠颜色区分。

### 7.6 Project Row

Project 是导航/管理对象，默认用 List Row，不使用大 Dashboard Card。

只显示：

- project name；
- lightweight production status；
- attention count / unmapped / script gaps 等少量制作摘要；
- current activity marker。

Project Row 可以承接旧 Overview 的轻量数据，但不能扩张成 KPI Dashboard。低频操作进入 context menu。

### 7.7 Task Row

Status Center 使用 Task Row：

- task name；
- project；
- state；
- progress；
- elapsed/updated；
- retry/cancel 等合法动作。

禁止把任务状态做成无结构 Card waterfall。

## 8. Status indicator families

状态指示器也不能只有一个万能 badge。

### 8.1 Connection Indicator

用于 Host / Team connection：

- 6px dot + label；
- Ready / Connecting / Error / Offline；
- 不使用大 pill 占 Toolbar。

### 8.2 Task Status

用于 durable background task：

- icon/dot；
- state label；
- optional progress bar；
- failed 时提供错误摘要和 retry。

### 8.3 Slate Status

用于现场拍摄事实：

- usable → green + `可用`
- partial → amber + `部分可用`
- ng → red + `NG`
- unknown → neutral + `未判断`

Slate Status **不等于** Editorial Decision。

### 8.4 Editorial / Review Decision

Individual Opinion 和 Editorial Decision 必须视觉分层：

- individual: lightweight segmented/label；
- final editorial: stronger authority treatment；
- Best / Keep / Reject 不得和 Slate `可用 / NG` 共用同一组件名或数据字段。

### 8.5 Availability / Media health

用于 clip 可播放/离线/缺 identity：

- Ready
- Offline
- Decode unsupported
- Identity missing
- Index pending

这些是媒体健康状态，不是 Slate/Review 状态。

## 9. Interaction state matrix

所有核心对象必须定义：

| State | Required treatment |
| --- | --- |
| Default | neutral surface |
| Hover | subtle surface shift |
| Selected | accent rail/border + selected surface |
| Keyboard Focus | visible focus ring，独立于 selected |
| Editing | 当前 field/cell stronger outline |
| Drag Source | opacity/ghost + source remains identifiable |
| Drag Target | explicit target outline/slot highlight |
| Disabled | lower contrast + no hover affordance |
| Error | local error border/label，不改变布局 |

Selected、Focus、Editing 可能同时存在，CSS 必须支持组合状态而非互相覆盖。

## 10. Workspace grammar

### 10.1 Slate — Production Ledger

目标：长时间录入和核对。

优先级：

1. Table
2. Quick Entry
3. Selection / Inspector
4. Add Take / File Drop
5. Review placement auxiliary disclosure

Toolbar 不承担跨页面导航。

Viewer 只在 Inspector 出现；默认不永久占据主表宽度。

### 10.2 Media — Media Browser

必须有：

- List mode：metadata dense；
- Grid mode：thumbnail recognition；
- Camera filter；
- Search；
- media health filter；
- Inspector player；
- manual camera/role editing。

Grid 与 List 使用同一 Camera identity 和 selected state。

### 10.3 Material / Script — Editorial Evidence Workspace

稳定三段：

`Target / Script | Take Pool | Inspector`

粗归集：左边是 Episode target。

精确归集：左边是 Script segment target。

Coverage 是 Script 的只读覆盖 view，不建立 parallel Script workbench。

Selection Thread 必须贯穿：

`Episode → Scene → Segment → Take → Camera → Viewer / Inspector`

拖拽目标只在合法 target 上高亮。

### 10.4 Review — Watch + Attention Filter

主循环：

`Watch → Judge → Comment/Opinion → Next`

本地 Review 只有一个 Production surface：Watch/看片。

顶部/列表筛选可以包含“需关注”，该 filter 汇总 issue、stale evidence、未归集和团队未裁决意见；原因在当前 Take Inspector 解释。Attention ranking 不能写入 authority。

Overview 不作为 Review peer page；轻量 production summary 进入 Project Home。

顶部只保留：项目 / 集数 / reviewer / connection / search / filter。

人物、建议、刷新等次级工具进入 secondary actions / overflow。

### 10.5 Timeline / Assembly

剪辑工作区遵循 NLE 语法：

- Viewer / Canvas；
- Timeline tracks；
- clip selection；
- playhead；
- inspector；
- timecode；
- markers。

粗剪 / 组接属于 Timeline 上的 proposal / preparation，不建立第二套 authoritative edit state。不要复用列表卡片模板代替 Timeline 对象。

## 11. Inspector contract

Inspector 只解释“当前选择”。

顺序：

1. identity / title
2. preview/player
3. primary editable fields
4. evidence / metadata
5. low-frequency actions
6. destructive actions at bottom

Inspector 不成为第二套导航。

当 selection 变化时：

- Inspector 内容更新；
- Inspector 宽度不跳；
- Header 和 action bar 不因内容缺失移动。

## 12. Drag and drop

拖拽必须满足：

- drag source 有抓取 affordance 或整个对象明确可拖；
- drag ghost 保留 Take / Camera identity；
- target hover 显示明确 outline/rail；
- illegal target 不响应；
- drop 成功使用 inline/toast 反馈；
- stale target / revision conflict 必须阻止写入并明确刷新；
- 拖动 Camera/Media 和拖动 Take 是不同 payload，不允许误投。

## 13. Empty, loading, error states

每个 Pane 必须有独立状态，不允许整页只显示一个模糊 spinner。

### Empty

说明：

- 当前为什么为空；
- 下一步最直接动作。

### Loading

保持 pane skeleton / stable dimensions，避免加载完成后布局跳动。

### Error

- local operation error → inline
- transient action error → toast/inline
- durable background failure → Status Center
- media decode error → player state

错误不能改变导航结构。

## 14. Responsive behavior

Desktop Production 首要目标是大屏专业工具，不做“所有东西响应成手机卡片”。

当窗口变窄：

1. secondary metadata hide/clamp；
2. Inspector 可 overlay；
3. secondary toolbar overflow；
4. 只有达到定义断点后才切换布局模式。

Web Review：

- `>1260`: Script / Takes / Inspector
- `901–1260`: Script + Takes / Inspector lower pane
- `<=900`: Inspector → Takes → Script
- `<=680`: Take vertical, toolbar horizontal scroll

Camera identity、decision control、player controls 在所有断点保持可用。

## 15. Accessibility

最低要求：

- keyboard reachable；
- `:focus-visible`；
- semantic button/input/table/dialog roles；
- aria-label 用于 icon-only controls；
- status 不只依赖颜色；
- camera 不只依赖颜色；
- `prefers-reduced-motion`；
- hover-only 信息必须有 keyboard/touch 等价入口。

## 16. Implementation rules

### 16.1 Tokens first

新增 UI 不得引入等价硬编码 palette。

统一 token groups：

- surface
- border
- text
- accent/status
- camera
- typography
- spacing
- radius
- control height
- focus
- z-index

### 16.2 No new theme layer

禁止新增 `final-theme.css` / `v3-fix.css` 之类覆盖层。

迁移方式：

1. 将现有 feature CSS 替换为 semantic tokens；
2. 删除重复 override；
3. v2 最终从“最后加载的修补层”收敛成基础 token/primitives；
4. workspace CSS 只描述各自独特 layout，不重新发明全局 button/card/status；
5. canonical component 完成迁移后，旧 page/theme/redesign 对其 anatomy 的 selector 必须删除，而不是留作兼容覆盖。

### 16.3 Semantic components

组件命名按对象，不按外观：

- `CameraBadge`
- `CameraSlot`
- `MirrorOrderMediaCard`
- `TakeCard / TakeListRow`
- `SlateRow / SlateTableHead`
- `ScriptBlock`
- `IdentityCandidateRow / PersonRow / IdentityPortrait`
- `SlateStatusControl`
- `ConnectionIndicator`
- `TaskStatus`
- `MediaHealthStatus`
- `ReviewDecisionControl`
- `InspectorSection`

禁止只有 `BlueBadge`、`GenericCard`、`SmallPill` 这种外观式 API 成为核心产品组件。

## 17. Automated contracts

至少建立以下 guard：

1. 核心 production CSS 不允许 `font-size: 7px/8px`。
2. Camera presentation 保证 A/B/C/AUX 固定 tone、label、sortOrder。
3. Slate 固定包含 A/B/C/AUX slot，不允许按存在机位动态改变列顺序。
4. 所有 icon-only button 必须 aria-label。
5. `:focus-visible` 合同存在。
6. Web responsive breakpoints 不回退。
7. status family 禁止直接复用 Slate status 作为 Editorial Decision。
8. MediaCard optional state 不改变核心 grid columns。
9. Take compact anatomy 只能由 `take-card.css` 所有；Slate/page stylesheet 不得重建。
10. Identity row / portrait anatomy 只能由 `identity-rows.css` 所有；Workbench/redesign stylesheet 不得重建。
11. Review 保持单一 Watch production surface；Attention 是 filter，Overview 摘要进入 Project Home。

## 18. Acceptance checklist

一个工作区只有满足以下条件才算 UI / UX 完成：

- 用户 3 秒内能判断当前项目、工作区、选中对象和下一步操作；
- A/B/C/AUX 机位在所有出现位置一致；
- 缺机位不发生 slot shift；
- 状态含义不用猜；
- keyboard focus 看得见；
- selection 和 focus 不混淆；
- 长文件名不会把状态/按钮挤错位；
- 加载、空、错误状态不改变主要结构；
- Inspector 永远解释当前 selection；
- 操作者身份不要求每个页面重复输入；
- 不出现 7–8px 生产文字；
- 不出现无意义 Card/Pill 堆叠；
- 不出现 AI 装饰性发光；
- 不出现同一个动作在三处不同 UI 重复；
- 不出现为 view/filter/summary 人为新增的平级页面；
- canonical production object 不被 page/theme/redesign CSS 改写 anatomy；
- Desktop 与 Web 共享 semantic grammar，但保持不同任务密度。

## 19. Migration priority

### P0 — correctness and visual invariants

- Camera identity + A/B/C/AUX slot contract
- MediaCard / TakeCard / SlateRow / ScriptBlock / Identity row anatomy ownership
- Slate column alignment
- status family split
- typography floor
- focus/selection/drag state matrix

### P1 — product shell

- four Production Areas
- Coverage → Script view
- Attention → Watch filter
- Overview → Project Home summary
- Current Operator / reviewer identity model
- Toolbar reduction
- Inspector contract

### P2 — flagship workspaces

- Slate
- Media Browser List/Grid
- Material/Script
- Watch/Review
- Timeline

### P3 — remaining professional surfaces

- Identity
- Delivery
- Status Center
- Settings

目标不是“每页长得一样”，而是让用户能明显感觉：**它们都属于同一套专业后期软件，同时每个工作区又像它真正处理的制作对象。**
