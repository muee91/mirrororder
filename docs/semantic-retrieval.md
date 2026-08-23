# 镜序语义检索与助理 Grounding

> 当前契约：`semantic_index.v1` / `semantic_search.v1`
>
> 本文描述设备本地、可重建的素材语义索引，以及镜序助理如何使用它回答自然语言问题。它不是新的审核权威，也不改变 `review.json`、`editorial.json`、`auto_decisions.json`。

## 1. 目标

镜序已有三类高价值证据：

1. **画面证据**：Take Perception / `TakeSemanticProvider` 对少量抽样帧生成的结构化描述。
2. **对白证据**：现有 ASR cache 与 Take 片内范围裁切后的转写 segment。
3. **人工生产证据**：`script_supervisor.v2` 电子场记记录、人工可用范围与备注。

此前这些证据存在于不同读模型里，镜序助理回答问题时主要收到项目摘要、异常队列与若干场记，并没有一个“用户问题 → 相关素材证据”的统一召回层。

当前链路补成：

```text
已有生产证据
  ├─ visual semantic JSON            Take 级
  ├─ ASR transcript segments         对白片段级
  └─ script supervisor
        │
        ▼
ProjectSemanticIndexer
  ├─ visual document
  ├─ speech segment documents
  └─ slate document
        │
        ├─ FTS / trigram 文本索引       始终可用或降级 LIKE
        └─ shared text embedding        可选
                  │
                  ▼
用户自然语言查询
  ├─ 同一 embedding encoder            可选
  ├─ keyword recall
  └─ vector cosine recall
        │
        ▼
RRF 风格融合排序
        │
        ├─ App「找素材」
        ├─ Host read-only API
        ├─ Agent read-only API / MCP
        └─ 镜序助理 grounding context
```

核心原则是：**写入侧文档与读取侧查询使用同一个编码器身份；编码器不可用时不伪造向量，自动退回文本检索。**

## 2. 与参考自然语言链路的关系

本实现吸收了成熟素材检索系统中三个有价值的结构性设计：

- 写入侧把视觉/语音结果转换为可搜索的自然语言文档；
- 文档与查询共用一个语义编码空间；
- 向量召回与关键词/FTS 召回并存，任一路不可用时仍可以降级。

镜序没有直接照搬“全片一次 VLM 分镜”或“新项目默认全量视觉模型扫描”，原因是镜序已有更严格的生产边界：视觉推理必须是稀疏、受预算控制、可缓存的增强证据，不能把项目准备成本升级成全素材 VLM 扫描。

因此当前 `ProjectSemanticIndexer.refresh()` **只索引已经存在的证据，不触发新的 VLM 或 ASR 推理**。深度视觉描述仍由 `PerceptionIndexer(mode="semantic")` / `evidence_extract` 等已有 bounded 流程产生。

## 3. 三类语义文档

### 3.1 visual

来源：设备本地 `takes.semantic_json`，只有 `semantic_status=ready` 才进入索引。

当前粒度仍然是 **逻辑 Take 级**，可检索字段包括：

- `summary`
- `description`
- `location`
- `shot_type`
- `visible_people[]`
- `actions[]`
- `props[]`
- `emotion[]`
- `continuity_clues[]`
- `extracted_text`
- `tags[]`

视觉 Provider 明确禁止：

- 猜真实演员姓名；
- 猜人物关系或动机；
- 发明剧本位置；
- 判断 Best / Keep / Reject；
- 把输入上下文中的 ASR 文本说成“从图片听到”。

对白继续由 ASR 独立进入 `speech` 文档。

### 3.2 speech

来源：当前设备可解析媒体对应的**既有 ASR cache**。

当前索引粒度已经升级为 ASR segment：

```text
源文件 ASR segment 时间
  ↓ slice_transcript(逻辑 Take 的 source_start/source_end)
Take-relative start/end
  ↓
semantic speech document
```

每个结果保留：

- `group_id`
- `clip_id`
- `media_id`
- `start / end`（相对逻辑 Take / 当前 member 的片内范围）
- `metadata.precision = asr_segment`
- `metadata.time_basis = take_relative`
- `metadata.camera`
- `metadata.transcript_backend`

同步多机位常常会在 A/B/C 缓存中出现同一句、同一时刻的重复转写。Indexer 使用现有 B/C/A 收音优先启发式，并只折叠**文本相同且时间近似重合**的多机位副本；同一句在稍后再次说出仍保留为独立 segment。

老缓存如果只有整段 `text`、没有 segment 时间戳，则保留 `take_fallback` 文档，不因为升级索引而失去原有搜索能力。

App 点击对白结果时：

```text
找到 group + clip
→ selectMember
→ member.source_start + result.start
→ player.currentTime
```

因此“定位对白”可以落到实际证据时间，而不是只打开整组 Take。

SQLite 中只保存项目身份与片内时间，不保存 `/Volumes/...` 等设备绝对路径。

### 3.3 slate

来源：`script_supervisor.v2.records`。

可检索内容包括：

- 集 / 场 / 镜 / 次；
- `usable / partial / ng` 等现场状态；
- 人工备注；
- 人工精确可用范围；
- 关联素材文件名、机位、人工景别和机位备注。

场记属于高价值人工生产证据，但仍不是 Editorial Decision。检索到“后面笑场”不能自动产生 Reject；检索到“导演说这条最好”也不能绕过 Final Editorial Decision 写入规则。

## 4. 设备本地存储

语义索引复用 `WorkspaceDatabase` 的设备本地 SQLite 文件，并延迟创建：

```text
semantic_documents
semantic_documents_fts          # unicode/token，SQLite支持时
semantic_documents_trigram      # CJK substring，SQLite支持时
```

`semantic_documents` 包含：

```text
project_id
document_id
group_id
clip_id
media_id
source
start / end
text
metadata_json
content_fingerprint
embedding
embedding_dim
embedding_model
updated_at
```

这张表属于 **device-local / rebuildable** 状态：

- 不进入 Dropbox / iCloud 项目共享权威；
- 不进入 `review.json` / `editorial.json`；
- 不把设备媒体绝对路径序列化进去；
- 删除数据库后可从共享项目事实 + 当前设备 ASR/感知缓存重建。

## 5. 统一编码器

`SemanticEncoder` 当前支持 OpenAI-compatible `/v1/embeddings` 接口。

设备连接增加第三个模型角色：

```text
text       语言解释 / 受限规划
vision     可选多模态增强
embedding  语义检索编码
```

配置优先级：

1. `MIRRORORDER_EMBEDDING_*` 环境变量；
2. 设备本地 `model-connections.json` 的 `embedding` 连接；
3. 未配置：关闭向量路径，仅使用文本召回。

关键约束：

- `embedding_model` 与文档向量一起保存；
- 查询只与当前 encoder identity 完全相同的向量比较；
- 模型变化后文档会在下一次 refresh 重新编码；
- endpoint 失败不会使搜索整体失败。

没有配置 embedding 模型时，产品界面显示“关键词模式”，而不是假装有语义向量能力。

当前交接构建**不强行打包一个未经跨 Mac/中文召回验证的 embedding 模型**。本地固定 embedding runtime 属于下一阶段模型验收，而不是本次构建阻塞项。

## 6. 混合召回

`SemanticSearcher` 执行：

```text
query
  ├─ FTS trigram / unicode recall
  └─ same-encoder vector cosine recall（如可用）
       ↓
     rank fusion
       ↓
visual / speech / slate evidence rows
```

当前融合分数只用于排序，不是“可信度”。UI 不应把它显示成判断置信度。

返回结果保留 provenance：

```json
{
  "group_id": "...",
  "clip_id": "...",
  "source": "visual | speech | slate",
  "source_label": "画面 | 对白 | 场记",
  "snippet": "...",
  "start": 0.5,
  "end": 1.7
}
```

App 本机响应可以包含诊断级 encoder / refresh 信息；远程 Team Web 与 Agent API 通过 `safe_search_payload()` 移除模型供应商、模型名和内部刷新细节。

## 7. 镜序助理 Grounding

以前：

```text
用户问题
  → project summary + attention + supervisor notes
  → LLM
```

现在：

```text
用户问题
  → semantic search
  → top visual / speech / slate evidence
  → project/attention 作为次级上下文
  → LLM
```

语言模型 system contract 要求：

- 优先使用 `semantic_retrieval`；
- 没证据时明确说证据不足；
- 不用常识补写素材内容；
- 场记“前半段”没有精确 I/O 时不能伪造秒数；
- 检索结果不能自动升级成 Best / Reject / 最终归集。

如果语言模型不可用，助理不再只返回“模型未连接”，而是直接列出最高相关的画面 / 对白 / 场记证据，因此自然语言找素材在离线文本检索模式仍可用。

## 8. API / CLI / MCP

Host / App：

```text
GET /api/v1/projects/{project_id}/semantic-search?q=...&limit=16
```

可选来源过滤：

```text
&sources=visual,speech,slate
```

Agent：

```text
GET /api/agent/v1/projects/{project_id}/semantic-search?q=...
```

CLI：

```bash
script-organizer semantic-search workspace.toml <project_id> "门口回头"
```

MCP tool：

```text
semantic_search
```

Agent 必须有 `read` scope。语义搜索没有写入版本，也没有通用 shell/exec 入口。

`AgentToolRegistry.search_project_semantics()` 是只读 helper，**没有加入模型可执行生产动作的 `SAFE_ACTIONS`**，因此检索不能借助规划器绕过生产工具 allowlist。

## 9. App 产品面

镜序助理面板增加“找素材”：

```text
找素材
[门口反应镜头 / 红色杯子 / 后面笑场           ][搜索]

画面 · Take ...       [看片定位]
对白 · Take ... 4.2s  [定位对白]
场记 · Take ...       [看片定位]
```

用户主界面只看制作语言，不出现 embedding / vector / cosine 等实现术语。

“语义检索设置”属于 App 高级模型连接，允许配置一个独立的 embedding endpoint。Team Web 不显示这些连接信息。

## 10. 刷新策略

索引刷新有两条入口：

1. `prepare_project / incremental_analyze / transcribe / evidence_extract / auto_resolve` 等相关生产结果完成后异步 refresh；
2. 用户搜索 / 助理回答前执行一次增量 refresh，保证刚写的场记和已有视觉/对白证据可被召回。

`content_fingerprint` 保证不重复写入未变化文档；已有向量在编码器暂时不可用时可保留。如果文本发生变化但编码失败，则不会拿旧文本向量冒充新内容。

重要：refresh 不调用 VLM 或 ASR，因此它不会把普通搜索变成新的媒体分析任务。

## 11. 红线

语义链不得：

- 写 `review.json`；
- 写 `editorial.json`；
- 写 `auto_decisions.json`；
- 产生自动 Reject / Best；
- 把 Audit 结论当作素材语义真值；
- 把媒体绝对路径写进语义文档；
- 因为开启搜索而全项目触发 VLM / ASR；
- 在 Team Web 暴露 API Key、模型地址、模型名或本机路径；
- 把检索排序分数展示成审核可信度。

## 12. 后续升级顺序

当前接口已经把 Encoder 与索引层解耦。后续若打包本地中文 embedding runtime，优先替换 `SemanticEncoder` 的 provider，而不改语义文档、搜索 API 或助理 contract。

本次交接已完成 **speech segment precision**，后续剩余顺序：

1. 真机验证现有项目 FTS / ASR segment / 场记检索质量；
2. 选择可商用、中文表现稳定的本地 embedding 模型与 ONNX/runtime；
3. 固化 tokenizer + 模型版本 fingerprint，并增加离线 recall benchmark；
4. 对视觉证据增加 bounded segment layer，而不是全项目无差别 VLM 扫描；
5. 视觉 segment 稳定后再评估 image-to-image / fast visual lane 的真实产品价值。

在这些验证完成前，不把 embedding 维数、具体模型品牌或“语义准确率”写死成产品承诺。
