# 镜序 Desktop 现有模块与代码职责

> 当前产品路线仅以 [`product/REBUILD_2026-11-17.md`](./product/REBUILD_2026-11-17.md) 为准。本文件维护实际 UI 路由与代码职责，不继承旧版四大标签页作为用户工作流。

## 项目内的三个阶段

### 01 / 同步与交付（原始素材项目）

| 模块 | 前端 owner | 行为 |
| --- | --- | --- |
| 同步任务 | `MulticamSyncTimeline.tsx` 中的 `SyncTaskWorkspace` | 运行阶段、最近进展、失败与重试；无可信分母则不显示总进度 |
| 同步核对 | `SyncInspectionWorkbench.tsx` | 独立的轨道与源媒体预览；尚未提供安全偏移写入或独立 WAV 帧级对齐 |
| 工程交付 | `SyncDeliveryWorkspace.tsx` | 使用 Host 已生成、经过本机路径校验的工程文件；不把 XML 文件存在视为 NLE 已实际验收 |

只有同步成功后才能从同步核对进入工程交付。失败时始终允许进入「素材库」与「本机素材」诊断。旧 `MulticamSyncTimeline` 仍是兼容组件，但新项目主导航不得再次把上述模块塞到同一个时间线页面。

### 02 / 拍摄素材

`交互场记`（真实拍摄顺序）、`剧本关联`（故事顺序与实际对白）、`演员与角色`、`素材库`、`本机素材` 是不同任务。现有 Material / Script / Identity 的底层事实模型继续复用；这些模块仍需要按照新视觉稿分别完成最终画布设计，不因导航拆分就宣称 UI 已完成。

### 03 / 剪辑辅助

`看片审阅` 保存人工判断；`选片组接` 仍由 Rust Timeline Core 维护唯一编辑 authority，不与同步母版共用编辑器。团队审阅是独立协作 surface。Team Web 是独立协作 surface，不得访问生产设备路径、原始媒体或 Final Editorial Decision 写入权限。

## 共同路由与兼容

`desktop/src/features/production/ProjectWorkbench.tsx` 负责项目会话、选择上下文与导航 intent；`ProjectModuleNavigation.tsx` 只负责模块列表和同步可用性。所有 project-specific 模块都复用现有 Core API，不建立第二套业务 truth。

原始素材目录项目的第一次打开进入 `sync-task`；旧 `timeline` 页面历史在新项目中迁移为同步入口。已经确认的 Take / clip / script segment 跨模块跳转携带原有选择上下文；本地媒体路径始终由 device binding 决定。

全局素材搜索、模型配置、状态中心和团队协作属于全局系统工具；未来可有专业界面，但不能抢占首次同步主任务。

## 不可伪称的能力

本轮工作是**可交互结构重制**，不是生产验证。必须进一步验收：独立 WAV、视频漂移/人工修正、真正原生多机位的四种 NLE 实机导入、跨机媒体重连、持久化同步版本与后续后台剧本/语义分析。实际状态见 [`engineering/STATUS.md`](./engineering/STATUS.md)。
