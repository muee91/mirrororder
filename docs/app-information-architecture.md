# App Product Experience Architecture

> 当前产品体验 authority：2026-09-02。
>
> 本文约束信息架构与产品壳层。当前 Desktop 开发入口见 [`../desktop/README.md`](../desktop/README.md)，跨层技术边界见 [`architecture/desktop-bridge.md`](./architecture/desktop-bridge.md)，视觉与交互规则见 [`ux-principles.md`](./ux-principles.md) 与 [`design-system-v2.md`](./design-system-v2.md)。

镜序 App 是专业影视后期 Production 工具，不是 Host/Workspace launcher、AI 控制台或模块 Dashboard。

核心体验目标：

- 用户打开 App 后尽快回到上次工作现场；
- 项目是长期上下文，始终可见；
- 每个项目有一个明确 Primary Canvas，而不是功能目录首页；
- 复杂能力按制作对象和阶段组织，不按工程模块组织；
- Host、端口、workspace.toml、模型实现等技术细节只在恢复/设置/高级区域出现；
- 视觉保持高密度、低噪声、Table / Split View / Inspector / Toolbar 的专业工具纪律。

## 1. 启动与恢复

### 正常启动

只记住**成功打开过的本机工作区**。Tauri 启动后：

1. 尝试恢复上次成功工作区；
2. 恢复上次项目；
3. 恢复该项目上次离开的 Production 页面；
4. 没有页面历史的新项目默认进入 **素材 → 场记**。

App 不允许用 `projects[0]` 作为隐式产品默认。

### 恢复失败

失败时停在低噪声恢复页：

- 重新定位工作区；
- 打开其它工作区；
- 清除自动恢复记录。

失败恢复不能清空当前项目数据，也不能把错误转换成 Review / Slate / Editorial 写入。

### 首次使用

首次使用主界面只回答一个问题：

> 打开哪个镜序工作区？

Host 地址、端口和“连接已运行服务”只放在 **工作区与连接 / 高级连接** disclosure 中。

## 2. 全局 App 壳层

打开工作区后，App 为全高 Production frame：

```text
┌──────────── Global Sidebar ────────────┬──────────────── Production Canvas ────────────────┐
│ 镜序                                  │ 项目 Toolbar                                      │
│                                       │ 素材 / 剧本 / 剪辑 / 审阅                         │
│ 项目                                  │ 当前区二级工作对象                                 │
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

Sidebar 只承担长期上下文与全局工具：

- 镜序品牌；
- 项目列表；
- 新建项目；
- 状态中心；
- 团队审阅；
- 设置；
- 底部工作区 disclosure。

项目行只展示：

- 项目名；
- Take / 素材等轻量摘要；
- 明确错误提示。

不得在 Sidebar 常驻展示路径、端口、模型名称、API revision 或后台日志。

### 工作区 disclosure

工作区是底层隔离概念，不是一级产品对象。底部 disclosure 只提供：

- 切换工作区；
- Finder / Explorer；
- 高级连接；
- 关闭下次自动恢复。

## 3. 项目 Production Toolbar

项目内只保留四个一级制作区：

### 素材

默认页：**场记**

- 场记
- 素材库
- Take
- 人物

### 剧本

- 剧本
- 覆盖

### 剪辑

- 粗剪
- 组接
- 时间线
- 交付

### 审阅

- 看片
- 待处理
- 概览

一级制作区使用项目 Toolbar 中的稳定 segmented navigation；二级工作对象在其下方使用低噪声二级导航。

`Audit`、`Agent`、`IdentityIndexer`、`Coverage Graph`、`Delivery Resolver`、embedding/runtime 等工程名不得成为一级导航。

## 4. Primary Canvas

项目必须始终有明确主工作画布。

### 新项目默认：电子场记

电子场记恢复为项目的 Primary Canvas，而不是被降级成普通功能页。

原因：

- 它是素材、Take、剧本、拍摄事实进入后期的第一个人工生产界面；
- Table 适合长时间、高密度扫描；
- 多机位事实、状态、备注、可用范围都需要稳定肌肉记忆；
- 后续 Coverage / Rough Cut / Assembly / Timeline 都消费其上下文，但不能取代它作为新项目的起点。

已有项目恢复上次页面，不强制回到场记。

### 场记空间纪律

- 场记 Table / 归集区尽量占满中央可用高度；
- Viewer 是临时/Inspector 工具，不永久占据一整列；
- 一行 = 一次 Take 记录；多机位属于同一行；
- 场记事实、Review placement、Editorial Decision 继续保持 authority 分离。

## 5. Contextual Tools

### 语义搜索

项目级搜索使用 `⌘K / Ctrl+K`，不是页面或一级 Tab。

搜索结果只提供 read-only evidence / retrieval ranking；不能成为 Editorial Best、Review placement 或置信度 authority。

### 小镜

小镜是右侧 contextual drawer：

- 打开时当前 Production Canvas 保持可见；
- 宽屏占右侧 Inspector 区；
- 窄屏可浮层覆盖；
- 不成为独立一级页面。

## 6. 全局工具

### 状态中心

所有后台任务统一进入状态中心：

- 同步；
- 转写；
- 匹配；
- 内容识别；
- 人物 / 声纹；
- Audit；
- 语义索引；
- 其它 durable tasks。

Production Canvas 只展示轻量进度/失败提示，不复制完整任务控制器。

### 设置

设置是全局工具，不是 Production Page。

当前项目可以为设置提供上下文，但“设置”不得出现在素材/剧本/剪辑/审阅二级导航中。

### 团队审阅

团队审阅是独立协作 surface，不属于本地“审阅 → 看片”。

Team Web 权限保持：

- 播放；
- 剧本 / Take 审阅；
- Individual Opinion；
- 人工归集；
- 协作上下文。

不得获得：

- 本机素材目录管理；
- Production 场记写入；
- 本地模型/runtime；
- Final Editorial Decision；
- Timeline / Delivery authority。

## 7. 新建项目

新建项目是低频流程：

- Sidebar 常态只显示“新建”；
- 点击后进入聚焦 modal；
- 主文案使用“检查 / 创建 / 后台整理”等用户语言；
- `WorkspaceRegistry`、`prepare_project`、task id 等实现细节不进入正常流程；
- 删除/移除项目进入 modal 内的低频危险区。

## 8. 视觉与交互纪律

当前产品遵循：

- 系统字体 / PingFang SC；
- 中性色为主；
- 小圆角；
- 高密度 Table / List；
- 清晰 selected state；
- Toolbar 不堆 permanent buttons；
- 主工作区不使用 KPI Dashboard、大卡片瀑布流、大面积渐变或 AI 发光视觉；
- 右侧区域解释当前选择，不成为第二套导航。

技术实现使用 React/Tauri，但最终产品应保持 macOS 专业工具的空间纪律，并为 Windows 提供同构 Production experience。

## 9. 明确禁止回归

不得重新引入：

- 首屏 Host/端口/Workspace launcher 大面板；
- “制作 / 团队协作”占据 App 顶部的巨大模式切换；
- 项目内部“设置”Tab；
- 每个算法一个一级页面；
- 自动选择 `projects[0]`；
- 新项目默认 Take/素材库而不是场记；
- 大 padding + 大圆角 Dashboard shell；
- 通过 UI 便利性跨越 Review / Slate / Editorial / Timeline authority。
