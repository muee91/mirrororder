# 镜序 App Design System v1

> 当前有效版本：2026-08-24。本文是 App / Team Web 新增界面的视觉与交互约束。代码与本文冲突时，应先确认产品语义再修改；不得为复用旧 Web Production UI 而降低原生边界。

## 1. 产品设计定位

镜序是专业影视后期 Production 工具，不是 AI 控制台，也不是营销型 Dashboard。

设计目标：

- 高密度但不拥挤；
- 长时间使用不疲劳；
- 层级稳定，用户能形成肌肉记忆；
- 一种能力只出现一种主要交互语言；
- App 使用 SwiftUI / AppKit / AVKit 原生实现；
- Team Web 只承担 Review / 播放 / 意见 / 协作；
- AI 作为生产辅助存在，不通过大面积渐变、发光或独立主题制造存在感。

设计参考体系：

- **Linear**：低噪声、稳定导航、密集列表、明确选中态；
- **AppFlowy**：把复杂能力收成少数稳定工作对象；
- **Apple macOS HIG**：Sidebar、Table、Split View、Toolbar、键盘和系统图标遵循平台习惯；
- **InterDirector**：仅借鉴固定工作区、主画布 + Inspector、媒体制作工具的空间组织；不借鉴金/紫/青多主题、发光 AI Badge、全大写标签和单文件 UI/业务耦合。

## 2. App / Web 产品边界

### App — Native Production

App 全程不依赖嵌入 Web Production UI。

禁止在 App 主制作画布中实例化：

- `WKWebView`
- `DesktopWebView`
- `production_mode.js`
- Team Web 页面作为生产工作区

App 可以通过系统浏览器打开 Team Web，但不能把它嵌回 App。

### Web — Team Review

Web 可以与 App 共用：

- 颜色语义；
- 字号层级；
- Media Card 视觉；
- 状态标签；
- 选中态；
- Inspector 信息顺序。

Web 不获得：

- Finder 文件拖入项目数据；
- AppKit 向 NLE 外拖；
- 本机模型与运行时设置；
- 场记 Production 写入；
- 项目创建/删除；
- 自动化生产任务控制；
- Final Editorial Decision 权限。

共享视觉，不共享脆弱 UI 实现。

## 3. 全局信息架构

### 3.1 App 启动 / 项目主页

存在项目库时，App 默认进入 **项目主页**，而不是自动钻入上次项目。

```text
┌──────────── Sidebar ────────────┬──────────────── Project Home ────────────────┐
│ 镜序 MirrorOrder               │ 全部项目                         搜索  +新建项目 │
│                                │                                                  │
│ ▣ 项目                         │ [Project] [Project] [Project] [Project]          │
│                                │ [Project] [Project] ...                          │
│ 最近项目                       │                                                  │
│ · 项目 A                       │                                                  │
│ · 项目 B                       │                                                  │
│                                │                                                  │
│ 状态中心                       │                                                  │
│ 设置                           │                                                  │
└────────────────────────────────┴──────────────────────────────────────────────────┘
```

项目卡统一规格，不因名称、统计或状态不同改变高度。

项目卡信息优先级：

1. 项目视觉区；
2. 项目名；
3. Take / 素材数；
4. 待处理计数；
5. 活跃任务仅用轻量 Progress 表达。

主页不是数据仪表盘。禁止堆 KPI 大卡、环形图或 AI 建议瀑布流。

### 3.2 项目打开后的默认主视觉

项目默认主视觉：**多机位电子场记板**。

旧的“素材与剧本”等制作能力继续作为原生二级工作区存在，但不能抢占项目首屏。

```text
Project
├── 场记（默认）
├── 素材 / 剧本
├── 后续：人物 / Coverage / 粗剪 / 组接 / 时间线
└── Team Review（外部浏览器）
```

新增能力优先进入现有对象、Inspector、二级页或工具栏，不无限增加一级入口。

## 4. 多机位电子场记板

### 4.1 核心数据视觉

**一行 = 一次拍摄 / Take 记录。**

场号、镜号、次号只记录一次；多机位并排属于同一行，不能把 A/B/C 拆成三条场记。

标准列顺序：

```text
序号 | 场号 | 镜号 | 次号 | A机 | B机 | C机 | 辅助/特殊 | 状态 | 可用范围 | 备注
```

当未来存在 D/E 等自定义同步机位时，应先提供横向扩展或“更多机位”策略，不允许通过增加行高堆卡片破坏扫描效率。

### 4.2 行为规则

- `Cmd-N`：新建场记；
- `Cmd-S`：顺序保存所有 dirty 行；
- 点击机位卡：选中场记行 + 选中该素材 + 右侧 Inspector 播放；
- 从 Take 加入：同一 Take 的 A/B/C/辅助素材一次性进入同一行；
- Finder 拖入：只通过本机 `media_id` / media inventory 解析，不把绝对路径写入共享项目；
- `I` / `O` 对应人工看片后的精确可用范围；
- “前半段可用 / 后半段可用”只能保留文字证据，不可推导虚假秒数；
- `preferred_clip_id` 是场记首选机位，**不是 Editorial Best**；
- 自动/AI 结果不能覆盖人工场记事实。

### 4.3 状态

场记状态只使用：

- 待定 `unmarked`
- 可用 `usable`
- 部分可用 `partial`
- NG `ng`

视觉：小面积背景 + 状态色 + 短文案。状态色是反馈，不是装饰。

## 5. MirrorOrder Media Card

所有素材显示统一为一个组件语义，不允许每个模块重新设计卡片。

### 5.1 两种尺寸

#### Compact

用于：多机位场记 A/B/C/辅助列、密集 Take 行。

当前 App 基准：约 `154 × 54`，高度固定。

内容：

- 缩略图；
- Camera / source role；
- 文件名；
- 景别（有值时）；
- 时长；
- 场记首选星标（如有）；
- Selected Checkmark；
- 同机位多文件 `×N`。

#### Inspector / Standard

用于：Inspector、素材详情、重点浏览。

当前 App 基准：约 `286 × 92`。

比 Compact 多显示：

- availability；
- source role；
- 更完整文件名/时长。

以后素材库可扩展更大的 16:9 Standard Grid Card，但必须沿用相同状态机与信息顺序。

### 5.2 状态机

Media Card 只有以下视觉状态：

1. Default
2. Hover
3. Selected
4. Missing / Unavailable
5. Disabled（只在确实不可交互时）

**Selected 必须显著。**

App 标准：

- `2px` Accent Border；
- 轻量 Accent Tint；
- 右侧/右上明确 Checkmark；
- 很弱的 accent shadow；
- 不依赖颜色单一线索。

Missing：

- `video.slash`；
- 降低对比；
- 明确“当前设备缺失/不可播放”；
- 不伪造缩略图。

### 5.3 缩略图

App 使用本机原生媒体能力获取可复核缩略图；当前实现可从 Host playback occurrence 用 `AVAssetImageGenerator` 生成片内首帧并缓存。

规则：

- 必须尊重 `source_start`；
- 长桥接素材不能一律取源文件 0 秒；
- 缩略图失败应安全降级；
- 大列表必须缓存 / 延迟工作，不能阻塞主线程；
- Team Web 可以采用不同技术实现，但视觉尺寸和选中态一致。

## 6. Inspector

右侧 Inspector 是“当前选择”的解释区，不是第二套导航。

场记 Inspector 顺序：

1. 当前场记坐标（序号 / 场 / 镜 / 次）；
2. 视频播放器；
3. 当前行全部机位卡；
4. 可用范围；
5. 备注；
6. Take / 剧本关联；
7. 低频危险操作。

Inspector 可收起。关闭 Inspector 后主 Table 应获得剩余空间。

## 7. Toolbar

工具栏只放当前工作区高频动作。

场记工具栏建议：

- 项目名 / 场记摘要；
- 素材 / 剧本；
- Team Review；
- 从 Take 加入；
- 新建场记；
- Inspector toggle；
- 状态中心；
- 刷新；
- 保存。

避免把每个功能做成 permanent 按钮。低频动作进入菜单、Inspector 或二级页。

## 8. 按钮规范

**全 App 只有三级动作。**

### Primary

- 当前画布最核心且明确的推进动作；
- 每个主要区域通常最多一个；
- 示例：新建项目、新建场记、确认创建。

### Secondary

- 高频但非唯一动作；
- 使用原生 `.bordered`。

### Tertiary

- 工具、toggle、Inspector 内辅助动作；
- 使用 `.borderless` / Toolbar icon。

Danger 只用于真实破坏性操作，不能拿红色做普通强调。

## 9. 图标规范

系统功能图标统一使用 **SF Symbols**。

允许例外：

- 镜序 Logo；
- 镜序助理头像 / mascot；
- 真实媒体缩略图。

禁止混用 emoji、Lucide、自绘 SVG 与 SF Symbols 作为同一层级系统图标。

## 10. 颜色

中性色承担绝大多数界面。

语义色：

- Accent：选择、主动作、定位；
- Green：可用 / 完成 / 在线；
- Amber：部分可用 / 待处理 / 警告；
- Red：NG / 错误 / 破坏性；
- Purple：只作为少量景别/辅助语义，不形成第二主色。

禁止：

- 不同业务模块各自拥有品牌色；
- AI 默认紫色发光；
- 大面积渐变与霓虹边框；
- 彩色状态填满整张大卡。

## 11. 字体与数字

- 标题、正文：系统字体 / PingFang SC；
- 文件名、时间码、序号、场镜次：系统 monospaced / monospacedDigit；
- 不引入外部字体作为运行时依赖；
- 不使用大量 uppercase 英文制造“专业感”。

层级参考：

- Page title: 20–24 semibold
- Section: 14–16 semibold
- Body: 13–14 regular
- Caption: 11–12
- Dense metadata: 10–11 monospaced

## 12. 空间与圆角

统一间距基线：`4 / 6 / 8 / 10 / 12 / 16 / 20 / 24`。

圆角：

- 小状态 / icon 背景：4–6
- 控件：6–7
- Media Card：8
- 项目卡 / 大面板：10
- Modal：10–12

不要通过不断增大圆角制造新组件。

## 13. Team Web 同构规则

Team Web 不需要像 App 一样完全深色，但同一素材必须“一眼看出是镜序同一个组件体系”。

Web Media Card：

- 固定尺寸；
- 文件名不改变卡片宽高；
- camera badge 位置固定；
- selected 使用明确 2px accent outline + check；
- missing 显式显示；
- 多机位横向排列；
- 点击仅执行 Review 选中/播放，不获得 Production 写权限。

Review 页面仍以：剧本 / Take / Inspector 为主，不复制 App 的多机位场记编辑表。

## 14. AI 视觉约束

镜序助理可以：

- 作为项目/当前 Take 的辅助入口；
- 在待处理、Inspector、Coverage 等上下文显示建议；
- 对低置信和异常给出自然语言解释。

镜序助理不能：

- 常驻占据主场记画布；
- 生成新的主色体系；
- 把模型名、token、runtime jargon 放进日常主 UI；
- 将建议视觉伪装成人工结论。

## 15. 新功能 UI Checklist

新增任何可见功能前必须回答：

1. 它属于项目主页、场记、素材/剧本、剪辑、Review，还是 Inspector？
2. 是否真的需要新的一级入口？
3. 能否复用已有 Toolbar / Table / Inspector / Media Card？
4. 使用 Primary / Secondary / Tertiary 哪一级动作？
5. 使用哪个现有状态语义？
6. 是否只使用 SF Symbols？
7. 是否引入新的任意宽高卡片？若是，为什么不能用 Media Card？
8. 是否把 AI 建议误画成了人工权威？
9. 是否把本机路径或运行时细节暴露到共享 Web？
10. App 是否仍然纯原生 Production？

任何一项答不清楚，应先修信息架构，不直接增加新按钮。

---

**当前产品视觉主线：项目主页 → 原生多机位场记 → 原生二级制作面；Team Web 独立 Review。**
