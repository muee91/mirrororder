# 镜序 App UI 设计规范 v1

> 适用范围：`镜序.app` 的原生 SwiftUI / AppKit Production 界面。
>
> 产品边界：App = 原生 Production；Team Web = 独立 Review。App 不复用 Web Production UI，不允许因为“已有网页页面”而嵌入 WKWebView。

## 1. 设计目标

镜序不是 AI 控制台，也不是后台管理系统。它是剪辑师和后期团队长时间使用的生产工具。

设计目标只有六个关键词：

- 克制
- 高密度
- 专业
- 清晰层级
- 原生感
- 长时间使用不疲劳

任何新增功能都必须优先减少切换、减少视觉噪音、减少重复入口，而不是增加新的“功能卡片”。

## 2. 参考体系

### 2.1 Primary reference：Linear

主要借鉴：

- 稳定左栏 + 明确工作区层级；
- 高信息密度列表；
- 极少的强调色；
- 工具栏低噪声；
- 状态、操作、对象层级清晰；
- 快速键盘操作优先于层层弹窗。

镜序不复制 Linear 的品牌皮肤，只借鉴它“减少噪音、保持速度和焦点”的产品方法。

参考：<https://linear.app/>

### 2.2 Structural reference：AppFlowy

主要借鉴：

- 复杂能力收敛为少数几个稳定对象；
- Search / Projects / Docs / AI 等能力不平铺为几十个按钮；
- AI 作为工作区能力，而不是单独的炫技页面。

参考：<https://appflowy.com/>

### 2.3 Platform reference：Apple macOS HIG

镜序是 macOS 原生应用，平台习惯优先于自造控件：

- 使用原生 Sidebar / SplitView / Table / Toolbar / Menu / Sheet；
- SF Symbols 作为唯一系统图标来源；
- 支持窗口缩放、分栏调整、键盘操作；
- 大屏显示更多内容，减少不必要 modal；
- 尊重系统 Accent Color、浅色 / 深色外观和辅助功能。

参考：

- <https://developer.apple.com/design/human-interface-guidelines/designing-for-macos>
- <https://developer.apple.com/design/human-interface-guidelines/sidebars>

## 3. 信息架构

### 3.1 全局层

左侧栏是整个 App 唯一长期全局导航：

```text
镜序

项目
  项目 A
  项目 B
  项目 C

镜序助理
状态中心
设置
```

规则：

1. 项目常驻左栏，不再出现“中央项目列表 → 再进项目”的中转页。
2. 左栏最多两级层次。
3. 项目打开后，中间大画布直接进入项目的默认 Production 工作区。
4. 状态中心只收后台任务、失败、同步 / 转写 / 识别 / Audit 状态。
5. 设置只收运行时、模型、本机素材、团队协作、诊断等低频配置。

### 3.2 项目层

项目内一级工作对象固定为：

```text
场记
素材
剧本
剪辑
```

其它能力必须成为二级面、Inspector、搜索结果、状态中心或助理动作，不得继续扩一级导航。

推荐映射：

```text
场记
  电子场记表
  快速录入
  素材关联

素材
  素材库
  Take
  人物
  找素材

剧本
  剧本
  归集
  Coverage
  连续性

剪辑
  粗剪
  组接
  时间线
  Delivery
```

## 4. 项目默认主视觉：电子场记板

点击一个已存在项目后，默认主画布不是“概览”，而是电子场记板。

原因：

- 场记是素材、剧本、拍摄事实、人工判断之间最自然的入口；
- 它可以承接纸质场记的二次录入；
- 录入的备注直接成为后续 AI / Coverage / Rough Cut 的高价值 Human Production Evidence；
- 它是制作行为，不和 Team Web 的 Review 页面语义冲突。

## 5. 电子场记板视觉规范

### 5.1 总体布局

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 项目 / 场记        集 24  ·  场 3      搜索素材   快速录入   🎙   筛选      │
├──────────────────────────────────────────────────────────────────────────────┤
│ 素材       集  场  镜  次  机位/类型  景别  状态   可用范围      备注        │
├──────────────────────────────────────────────────────────────────────────────┤
│ [A][B][C]   24  3   2      A/B/C      …   可用   全条                       │
│ [A][B][C]   24  3   3      A/B/C      …   部分   前半段         后面笑场    │
│ [DJI]       24  3   —      航拍       —   可用                 饭店建立镜   │
└──────────────────────────────────────────────────────────────────────────────┘
```

场记表占据中央画布至少 70% 的视觉权重。

### 5.2 表格列

第一版标准列：

| 列 | 用途 | 编辑方式 |
|---|---|---|
| 素材 | 一次拍摄关联的 A/B/C 或辅助素材 | 视频卡 / 拖入 / 搜索 |
| 集 | 剧集编号 | 数字 / 快速继承 |
| 场 | 场次 | 文本或数字 |
| 镜 | 镜号 | 文本或数字 |
| 次 | Take 次数 | 数字 |
| 机位 / 类型 | A/B/C 或航拍、GoPro、空镜等 | Menu |
| 景别 | 全景 / 中景 / 近景 / 特写等 | Menu / 快捷键 |
| 状态 | 可用 / 部分 / NG / 未定 | 单选 |
| 可用范围 | 全条 / 前半段 / 后半段 / I-O 精确范围 | 文本 + I/O |
| 备注 | 原始人工文字 | 直接输入 |

禁止：

- 把 AI 推断列作为默认常驻列；
- 把内部 `group_id / media_id / candidate_id` 暴露成主列；
- 把算法置信度作为场记员必须填写的字段；
- 用卡片瀑布流替代表格。

### 5.3 素材单元格

素材列使用紧凑视频卡，而不是纯文件名：

```text
┌────────┐ ┌────────┐ ┌────────┐
│  A画面 │ │  B画面 │ │  C画面 │
└────────┘ └────────┘ └────────┘
A023.mov    B019.mov    C021.mov
```

规则：

- 缩略图优先 16:9；
- 单张卡高度控制在 52–64 pt；
- 文件名是一等信息，必须可见；
- A/B/C 角度横向排列，不换行；
- 辅助素材用同一种视频卡，仅以 `source_role` 区分；
- 选中素材使用 Accent 细边框，不用大面积高饱和背景。

### 5.4 行高

三档密度：

```text
Compact   56 pt
Standard  68 pt   ← 默认
Comfort   80 pt
```

场记表默认 Standard。

不要让用户因为“视频卡”被迫接受 120–160 pt 的巨大行高。

### 5.5 右侧 Inspector

Inspector 默认可折叠，不与表格抢视觉。

只显示当前选中行：

- 大视频预览；
- A/B/C 机位切换；
- 关联剧本；
- 人工场记原话；
- AI 对备注的解释；
- 当前问题 / 连续性提示；
- 当前素材的本机状态。

AI 解释必须明确标为“建议 / 理解”，不可冒充原始场记。

## 6. 录入交互

场记板必须键盘优先。

### 6.1 基础键位

```text
Tab          下一字段
Shift+Tab    上一字段
Enter        保存并进入下一字段 / 下一行
Space / K    播放 / 暂停
J / L        前后播放
I / O        打可用入点 / 出点
⌥ Space      Push-to-talk 场记录入
⌘F           搜索项目素材
```

备注文本区正常支持换行，不抢 Enter。

### 6.2 快速继承

新建下一条时默认继承：

- 集
- 场
- 镜
- 机位结构

不默认继承：

- 次数
- 状态
- 可用范围
- 备注

自然语言“同上 / 下一条第三次 / B机改特写”等允许在确认预览后填入结构字段。

### 6.3 AI / 语音

AI 只承担：

- 自然语言 → 场记字段解析；
- 对备注的语义解释；
- 根据备注提出粗剪约束候选；
- 发现“部分可用但没有 I/O”等缺失信息；
- 找素材 / 找相关 Take。

AI 不得：

- 把“前半段”凭空变成精确秒数；
- 把“NG”直接写成 Editorial Reject；
- 把“导演说最好”直接写成 Final Best；
- 改写原始备注文本。

## 7. 颜色系统

颜色只承担层级和状态，不做装饰。

### 7.1 Surface

建议沿用当前 `AppTheme`，统一命名：

```text
surface.canvas      AppTheme.background
surface.sidebar     AppTheme.sidebar
surface.panel       AppTheme.panel
surface.elevated    AppTheme.elevated
border.default      AppTheme.line
text.primary        AppTheme.text
text.secondary      AppTheme.secondary
accent              Color.accentColor
```

不新增页面级主题色。

### 7.2 状态色

```text
success   AppTheme.green
warning   AppTheme.amber
error     AppTheme.red
info      AppTheme.accent
neutral   AppTheme.secondary
```

状态色只用于：

- 文字；
- 小圆点；
- 左侧 2–3 pt 标记；
- 极浅背景；
- 状态标签。

禁止整张卡片铺纯绿 / 纯黄 / 纯红。

### 7.3 Accent

Accent 使用系统 `Color.accentColor`，尊重用户 macOS Accent 设置。

禁止在 Sidebar 图标上固定品牌蓝 / 紫。

## 8. 字体层级

全部使用系统字体，不自带字体包。

推荐层级：

```text
Window / page title      .title2 / semibold
Section title            .headline / semibold
Primary row title        .subheadline / medium|semibold
Body                     .callout / regular
Secondary metadata       .caption
Tertiary metadata        .caption2
Timecode / count         monospacedDigit()
File / technical ID      monospaced() only when necessary
```

禁用：

- 全大写导航；
- 过多粗体；
- 用 20+ pt 字号做普通工作区标题；
- 每个模块自己定义字号。

## 9. 间距系统

采用 4 pt 基础网格：

```text
2   微小间隔
4   紧密内部间隔
6   行内控件
8   常规内部间隔
12  组件 padding
16  区域 padding
24  大区间隔
```

不建议出现 5 / 7 / 11 / 13 / 19 等随手数字。现有代码可逐步迁移，不要求一次性重写。

## 10. 圆角系统

只允许三档：

```text
small   6 pt   按钮、选中行、小状态
medium  10 pt  视频卡、Inspector block
large   12 pt  Sheet 内大容器（少用）
```

禁止：

- 16–24 pt 的消费级“大胶囊”；
- 所有文字都套 pill；
- 同一页面出现 5 种圆角。

## 11. 按钮系统

全 App 只有三级动作。

### Primary

适用于：

- 创建
- 保存
- 确认
- 开始整理
- 明确 destructive 流程前的最终确认（红色）

实现优先：

```swift
.buttonStyle(.borderedProminent)
```

一个区域最多一个 Primary。

### Secondary

适用于：

- 打开
- 绑定素材
- 团队审阅
- 运行某个明确工具

实现优先：

```swift
.buttonStyle(.bordered)
```

### Tertiary / Ghost

适用于：

- 刷新
- 关闭
- 展开
- 排序
- Inspector 辅助工具

实现优先：

```swift
.buttonStyle(.plain)
// 或 borderless
```

### 禁止

- 一个页面 6 个同等权重的 bordered 按钮；
- 为每个功能自定义一套彩色 ButtonStyle；
- 图标按钮没有 `.help()`；
- 小于 30×30 pt 的常用点击目标。

## 12. 图标系统

唯一标准：SF Symbols。

规则：

- Sidebar、Toolbar、列表、状态全部使用 SF Symbols；
- 业务图标不混用 emoji；
- 不引入第二套 icon font；
- 自定义品牌视觉只允许 Logo 和镜序助理角色头像；
- 同一动作全 App 使用同一 symbol。

建议映射：

```text
项目          film.stack
场记          tablecells
素材          rectangle.stack
剧本          doc.text
剪辑          timeline.selection
搜索          magnifyingglass
人物          person.2
镜序助理      使用用户指定角色头像，不用机器人 icon
状态中心      clock.arrow.circlepath
设置          gearshape
刷新          arrow.clockwise
筛选          line.3.horizontal.decrease.circle
警告          exclamationmark.triangle
缺失媒体      externaldrive.badge.xmark
```

## 13. 状态标签系统

状态标签只有一个组件外观，颜色按语义变化。

### 场记状态

```text
可用      success
部分可用  warning
NG        error
未定      neutral
```

### 自动生产状态

```text
自动       success
AI确认     info
人工       primary text / neutral
待处理     warning
未归集     neutral
```

### 权威区分

标签文本必须区分：

- `角色候选` ≠ `已确认角色`
- `AI建议` ≠ `人工决定`
- `Audit disagree` ≠ `Reject`
- `自动归集` ≠ `Best`

## 14. Sidebar 规范

默认宽度 220–240 pt，当前 224 pt 合理。

项目行结构：

```text
[icon] 项目名
       610 Take · 12 待处理
```

规则：

- 选中：Accent 8–12% 浅背景；
- 不使用强描边；
- 项目状态最多一行次级文字；
- 高优先异常最多显示一个数字；
- 删除、Finder、重新整理放 Context Menu，不占常驻行空间。

## 15. Toolbar 规范

Toolbar 是当前工作对象的操作区，不是“所有功能入口”。

场记 Toolbar 示例：

```text
场记 · 24场               [搜索] [快速录入] [🎙] [筛选]          保存状态
```

禁止把：人物库、设置、模型、Audit、Agent API、团队审阅、Coverage、粗剪全部塞进同一条 Toolbar。

跨模块入口必须走 Sidebar / 项目一级导航或 Menu。

## 16. Inspector 规范

Inspector 用于“当前选择的详情和上下文”，不是新页面。

推荐宽度：300–360 pt，可收起。

内容优先级：

1. 当前视频 / 当前对象；
2. 人工事实；
3. 当前选择可执行操作；
4. AI / Audit 建议；
5. 技术 metadata。

技术字段默认折叠。

## 17. Sheet / Dialog 规范

Sheet 只用于：

- 新建项目；
- 确认破坏性操作；
- 人物确认；
- 少量低频配置；
- 场记快速录入确认。

高频任务不得用 Sheet：

- 逐条场记录入；
- 逐 Take 看片；
- 机位切换；
- 常用筛选；
- Best/Keep/Reject；
- 搜索。

## 18. 镜序助理视觉规范

角色头像使用用户指定卡通形象。

尺寸：

```text
Sidebar / Toolbar        24–28 pt
Assistant list item      28–32 pt
Panel header             40–48 pt
High-priority nudge      36–44 pt
```

禁止：

- 大面积 AI 渐变；
- 发光机器人 icon；
- 每条 AI 信息都动画；
- 助理面板比当前制作对象更抢视觉。

助理的存在方式是“优先级和动作”，不是聊天窗口常驻占屏。

## 19. 面板与列表组件

优先顺序：

```text
Table / List
SplitView
OutlineGroup
Inspector
Menu
Sheet
Card（最后选择）
```

镜序默认不要“Dashboard 卡片化”。

只有以下对象适合 Card：

- 视频素材；
- 人物样本；
- AI 主动提醒中的单一问题。

统计数字、设置项、场记记录、剧本段、任务列表不使用大卡片。

## 20. 键盘与焦点

Mac Production 工具必须完整考虑键盘焦点。

要求：

- 所有高频动作有快捷键或可 Tab 到达；
- 表格编辑后焦点位置可预测；
- 打开 Inspector 不抢走当前输入焦点；
- Sheet 关闭后焦点回到原对象；
- Space / JKL 播放行为只在非文本输入焦点时生效。

## 21. 动效

动效只承担状态变化：

- 面板展开 / 收起；
- 行插入；
- Selection；
- Loading；
- Inspector 切换。

时长尽量跟随系统默认。

禁止：

- 页面切换飞入；
- AI 头像持续浮动；
- 大量 spring；
- 为普通按钮添加品牌动画。

## 22. 新功能接入检查清单

任何新增 App 功能，在写 UI 前必须回答：

1. 它属于 `场记 / 素材 / 剧本 / 剪辑` 中哪个一级对象？
2. 它是否其实应该是 Inspector、菜单、搜索结果或状态中心？
3. 它复用哪个现有 Button 层级？
4. 它使用哪个标准 SF Symbol？
5. 它使用哪个标准状态标签？
6. 是否引入了新的颜色、圆角、字号、阴影？如果是，为什么现有 token 不够？
7. 它是否抢占主工作对象的视觉？
8. 它是否支持键盘操作？
9. AI 建议与人工事实是否明确区分？
10. Team Web 是否真的需要这个能力？如果不是，不得为了复用而嵌 Web。

未回答以上问题，不进入 UI 实现。

## 23. 禁止模式

以下模式视为设计回归：

- 每加一个功能就增加一级导航；
- 一屏大量 bordered button；
- 多套 icon 风格；
- emoji 充当生产工具 icon；
- 每个模块自定义主题色；
- AI 紫色渐变 / 发光；
- 为数据显示大 Dashboard 卡片；
- 把内部算法名作为主 UI 文案；
- 把 `Audit / Agent / Embedding / VLM / Runtime` 平铺成普通用户一级页面；
- App 为复用页面重新嵌 WKWebView；
- 同一语义在不同页面用不同名称。

## 24. 第一阶段实施顺序

这份规范不是要求一次性重写现有所有 SwiftUI。

建议按下面顺序逐步迁移：

1. 场记板成为项目默认主工作区；
2. 提取共享 Design Tokens / 状态标签 / Toolbar / Inspector 组件；
3. 统一 Sidebar 和项目行；
4. 统一人物、素材、剧本、剪辑工作区；
5. 原生迁移 Best/Keep/Reject、归集、Coverage、粗剪、组接；
6. 原生实现 AppKit 文件拖拽与时间线；
7. 最后删除已无运行价值的 Web Production compatibility 代码。

## 25. 设计验收基线

一个新版本在视觉上可以交付，至少需要满足：

- 点击项目后 1 秒内能理解主工作对象；
- 场记表在 1440px 宽窗口仍能完成核心录入；
- 1280px 宽时通过可折叠 Inspector / 列宽调整保持可用；
- 新功能没有增加第四种按钮样式；
- 新功能没有增加第二套 icon；
- 深色 / 浅色均清晰；
- 键盘录入路径完整；
- 重要状态不用只靠颜色表达；
- AI 建议不会覆盖人工事实；
- App 全程不依赖嵌入 Web Production UI。
