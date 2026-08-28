# 镜序本地智能与可重建索引

镜序把**共享项目事实**和**当前设备可重建的智能索引**分开。删除本机索引可以降低功能或触发重建，但不能丢失人工场记、Review placement 或最终 Editorial Decision。

## 1. 本机工作区数据

每个 `workspace_id` 在当前设备上拥有独立的本机数据库和缓存目录。典型 macOS 位置：

```text
~/Library/Application Support/MirrorOrder/
└── workspaces/
    └── <workspace_id>/
        ├── workspace.sqlite3
        └── frames/
```

这类数据不放进共享 workspace，也不应通过普通文件同步让多台设备同时写一个活跃 SQLite。

本机索引可保存或派生：

- 项目 / Take 的本地检索索引；
- 代表帧与帧元数据；
- 感知 / VLM 结构化描述；
- ASR 与语义检索所需的本机派生信息；
- 人脸、声纹与人工确认后的身份观察；
- 后台感知和索引任务状态；
- 可重建的 semantic documents / embeddings。

共享项目 authority 仍由项目文件、ReviewStore、Script Supervisor、Editorial Decision 等对应业务存储维护，本机 SQLite 不取代这些人工事实。

## 2. 感知与代表帧

镜序优先复用已经抽取的低分辨率代表帧，而不是为了每个新能力重新扫描整段视频。

代表帧和视觉描述属于设备本机缓存：

- 可以删除和重建；
- 可以用于素材预览、VLM 分析和多模态检索；
- 路径本身不应成为共享项目事实；
- 感知失败不能回滚同步、ASR、剧本匹配或人工审核。

VLM 负责描述“画面里发生了什么”，不负责成为最终人物身份、Best、Reject 或剪辑判断的 authority。

## 3. 人脸与声纹

人脸与声纹能力已经属于当前本机 Identity 工作流，而不是只预留 schema。

基本原则：

```text
本机 observation / embedding
        ↓
候选聚类或身份建议
        ↓
人工确认
        ↓
项目中的人物 / 角色事实
```

- 生物特征向量只保存在当前设备的受控本机索引；
- Team Web 不直接获得 face / speaker embeddings；
- 聚类 ID 与真实演员 / 角色名称必须区分；
- 人工确认优先于自动建议；
- 人物或声纹相似度不能直接成为 Editorial Decision。

## 4. 语义检索

当前语义检索采用统一 semantic document 层组织可检索证据，来源可以包括视觉描述、对白和人工场记等。

```text
项目证据
  ↓
Semantic Documents
  ↓
本机 SQLite / FTS / 可选 embedding
  ↓
混合检索
  ↓
⌘K / 小镜 grounding / 其它只读召回
```

检索结果只代表相关证据，不代表剪辑置信度、Best、Review placement 或最终选择。

更具体的合同见 [`docs/semantic-retrieval.md`](./docs/semantic-retrieval.md)。

## 5. 本地模型与外部连接

本地模型、身份运行时和外部 / 自定义模型连接都属于**设备本机配置**：

- 本地运行时在 Desktop `设置` 中启用、准备和查看状态；
- Provider、服务地址、模型名和 API Key 也集中在 `设置`，不放在小镜日常 Drawer；
- API Key 不在 UI 中回显，也不写入共享项目；
- 未配置模型时，确定性主流程和可用的离线回退仍应工作；
- 如果显式配置远端视觉模型，上传范围必须受 Host 约束，不能把整个项目媒体无界发送给 provider。

## 6. 故障与 authority 原则

本地智能属于增强层：

> 智能索引或模型失败，可以降低检索、人物建议或视觉理解能力，但不能破坏项目事实和人工工作。

任何模型输出都遵循：

```text
evidence / suggestion
        ↓
human confirmation when authority changes
        ↓
authoritative store
```

模型、Audit、语义检索和小镜都不能绕过 ReviewStore、Script Supervisor、Editorial Decision 或 Rust Timeline 的既有 authority。
