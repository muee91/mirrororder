# 镜序本地感知索引

镜序把“项目事实”和“本机可重建的 AI 感知索引”分开。

## 1. 工作区数据库

每个 `workspace_id` 在当前 Mac 上拥有独立 SQLite：

```text
~/Library/Application Support/MirrorOrder/
└── workspaces/
    └── <workspace_id>/
        ├── workspace.sqlite3
        └── frames/
```

数据库不放进共享 workspace，不通过 iCloud/Dropbox/普通网盘同步。原因是 SQLite WAL 适合由一台 Host 进程本机并发读写，不适合让多个设备通过文件同步同时写同一个活跃数据库。

当前 schema v1 的职责：

- 项目摘要和当前分析状态的本机索引；
- Take 结构；
- 代表帧；
- Take 语义描述；
- 感知任务运行记录；
- Web/Agent 后续请求 AI 再分析的请求记录；
- 未来可选的人脸 / 说话人 identity 与 observation。

以下仍然是共享项目事实权威，不在 v1 中迁移到 SQLite：

- `workspace.toml`
- `projects/registry.json`
- `project.toml`
- `material_index.json`
- `script.json`
- `matches.json`
- `review.json`

这样数据库损坏或删除时可以重建，不会丢失人工审核。

## 2. 分层感知策略

### Tier 0：自动后台索引

项目完成同步 / ASR / 匹配后：

1. 把 Take 结构同步到工作区 SQLite；
2. 每个 Take 只抽取一张中点代表帧；
3. 代表帧缩放到 640px 宽度级别；
4. 保存在 Application Support，而不是项目共享目录。

Tier 0 不调用 VLM，不连续逐帧扫描。

### Semantic：按需深度索引

`evidence_extract` / 疑难 Take / 团队主动请求 AI 时：

1. 对指定 Take 抽取最多 3 张语义采样帧；
2. 读取已有 ASR 和候选剧本上下文；
3. 调用已配置的 VLM；
4. 只生成结构化描述：场景、景别、人物数量/描述、动作、道具、情绪、连续性线索；
5. 写入本机 SQLite。

语义结果不是 Best / Keep / Reject，也不是人工审核事实。

## 3. 演员和角色音色

数据库已经为以下本机可选能力预留：

```text
face identity
speaker identity
identity observation
embedding
```

但默认不启用识别 provider。正式接入前必须满足：

- 模型许可证允许镜序的目标发行方式；
- 用户明确启用；
- embedding 只保存在本机工作区数据库；
- Web 不直接获得生物特征向量；
- UI 把“聚类身份”与“真实演员/角色名称”分开；
- 人工确认过的演员/角色映射优先于自动聚类。

推荐流程：

```text
Face/Speaker embedding
        ↓
项目内聚类
        ↓
Person 01 / Speaker 02
        ↓
人工一次确认
        ↓
演员 / 角色
```

VLM 负责“画面里发生了什么”，不负责成为演员真实身份的唯一判断器。

## 4. 数据边界

- 原始视频不写入 SQLite；
- 代表帧是可删除、可重建缓存；
- face/speaker embedding 属于敏感本机索引，不进入共享 workspace；
- 本地 Qwen3-VL 只读取抽取帧，不直接读取整个视频；
- 如果未来显式配置远端 VLM，Host 只能发送抽取帧和有限上下文，并必须在 UI 中明确标示该 provider。

## 5. 故障原则

感知索引属于增强层：

> 感知失败不能让同步、ASR、剧本匹配或人工审核任务失败。

`prepare_project` 会在主分析完成后尝试 Tier 0；SQLite、FFmpeg 抽帧或 VLM 失败只记录为 deferred / failed perception，不回滚项目事实。
