# 镜序 App Design System v1 — 历史参考

> **状态：Historical Reference。** 这份文档记录 SwiftUI V1 阶段形成的视觉与交互纪律，不再定义当前 Desktop 技术栈、导航结构或默认入口。
>
> 当前产品与信息架构 authority：[`app-information-architecture.md`](./app-information-architecture.md)
>
> 当前通用 UX 原则：[`ux-principles.md`](./ux-principles.md)

## 仍然有效的设计纪律

V1 最有价值的部分继续约束当前 React/Tauri Desktop：

- 镜序是专业影视后期 Production 工具，不是 AI 控制台或营销型 Dashboard；
- 高密度但不拥挤，适合长时间使用；
- 稳定层级优先于不断增加一级 Tab；
- 主工作对象优先使用 `Table / List / Split View / Toolbar / Inspector` 的桌面工具语言；
- 主画布必须明确，低频管理和诊断不能占据主要视觉空间；
- 选中态、键盘操作、播放控制和 Inspector 位置应形成肌肉记忆；
- AI 是生产辅助，不能通过大面积发光、渐变或独立主题抢占视觉层级；
- Team Web 只承担 Review / 播放 / 个人意见 / 协作，不成为本机 Production 主画布。

## 当前已经取代 V1 的部分

以下内容只属于历史实现，不再作为开发要求：

- SwiftUI / AppKit / AVKit 是唯一 Desktop UI 技术栈；
- Project Home Grid 是进入项目的必经页面；
- Swift 原生项目主页决定当前导航；
- 旧 Swift 客户端目录和旧 WebView bridge 是当前 App 入口；
- V1 文档中任何与当前四区 Production IA 冲突的默认页和导航定义。

当前 Desktop 基线是 React / TypeScript + Tauri / Rust + Python Core；项目常驻左侧 Sidebar，项目内保持 `素材 / 剧本 / 剪辑 / 审阅` 四个稳定区域。第一次进入新项目默认打开 `素材 → 场记`，之后恢复项目最后离开的 Production Canvas。

## V1 对当前页面的具体启发

### 场记

- 电子场记仍是新项目的 Primary Canvas；
- 一行一个逻辑 Take；
- 多机位信息横向表达；
- Table 优先于卡片墙；
- 快速录入、上下条导航和键盘确认属于核心工作流；
- 右侧上下文信息不得挤占主表格的有效空间。

### 素材 / 剧本 / 剪辑 / 审阅

- 页面优先形成“主列表 / 主画布 + Inspector”的稳定空间结构；
- 相同语义使用相同控件与密度；
- fixed evidence card、固定置信度卡等几何约束由当前组件契约维护，而不是在此文档重复定义尺寸。

### 全局工具

- 状态中心、团队审阅、设置属于全局工具，不是项目 Production Tab；
- Host、端口、Python 路径、发布 gate 等工程细节只在低频高级区域出现；
- 小镜是 contextual drawer，⌘K 是项目检索工具，两者都不成为新的一级业务区。

## 维护规则

不要再向本文件添加新的产品入口、技术栈或当前状态说明。新的产品体验规则写入 `app-information-architecture.md` 或 `ux-principles.md`；具体领域契约写入对应领域文档。
