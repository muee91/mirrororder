# 镜序语义检索与小镜 Grounding

> 当前契约：`semantic_index.v1` / `semantic_search.v1`
>
> 本文描述设备本地、可重建的语义检索层，以及小镜如何使用它回答项目问题。它不是审核权威，也不改变 `review.json`、`editorial.json` 或 `auto_decisions.json`。

## 1. 目标与证据来源

镜序把三类已经存在的生产证据统一成 searchable semantic documents：

1. **visual** — Take Perception / `TakeSemanticProvider` 已生成的画面描述；
2. **speech** — 当前设备已有 ASR cache，优先使用 Take-relative segment；
3. **slate** — `script_supervisor.v2` 的人工场记事实、备注和可用范围。

```text
已有生产证据
  ├─ visual semantic JSON
  ├─ ASR transcript segments
  └─ script supervisor records
        ↓
ProjectSemanticIndexer
        ↓
device-local SemanticStore
  ├─ FTS / trigram / LIKE fallback
  └─ optional shared text embedding
        ↓
SemanticSearcher
  ├─ keyword recall
  ├─ vector cosine recall（可选）
  └─ RRF-style fusion
        ↓
⌘K / Ctrl+K 项目搜索
小镜 grounding
Host / Agent read-only API
```

核心原则：**索引只整理已有证据，不为了搜索重新触发 VLM 或 ASR。**

## 2. 三类语义文档

### visual

来源是设备本地已就绪的 Take semantic data。当前仍以逻辑 Take 为主要粒度，可包含：

- summary / description / location / shot_type；
- visible_people / actions / props / emotion；
- continuity_clues / extracted_text / tags。

视觉描述是可重建 evidence，不得猜真实演员身份、剧本位置、Best / Keep / Reject 或最终剪辑结论。

### speech

来源是当前设备可解析媒体对应的既有 ASR cache。

有 segment 时间时：

```text
source transcript segment
  ↓ slice_transcript(source_start / source_end)
Take-relative start / end
  ↓
speech semantic document
```

同步多机位的近似重复句会按现有 B/C/A 音频证据顺序折叠；同一句在稍后再次说出仍保留。旧缓存没有 segment 时保留 Take-level fallback。

语义文档只保存 `group_id / clip_id / media_id / start / end` 等身份和片内时间，不保存 `/Volumes/...` 等设备绝对路径。

### slate

来源是 `script_supervisor.v2.records`，包括：

- 集 / 场 / 镜 / 次；
- usable / partial / ng 等现场状态；
- 人工备注；
- 人工精确可用范围；
- 关联素材的机位、文件名、景别和备注。

场记是高价值人工生产证据，但不是 Final Editorial Decision。检索到“后面笑场”不能自动产生 Reject；场记 `NG`、素材 Exclusion 与 Editorial Reject 继续保持独立语义。

## 3. 设备本地存储

语义索引复用 `WorkspaceDatabase` 的设备本地 SQLite：

```text
semantic_documents
semantic_documents_fts
semantic_documents_trigram
```

主要字段：

```text
project_id / document_id
group_id / clip_id / media_id
source
start / end
text / metadata_json
content_fingerprint
embedding / embedding_dim / embedding_model
updated_at
```

它属于 **device-local / rebuildable** 状态：

- 不进入共享 workspace authority；
- 不进入 Review / Editorial；
- 不同步模型 secret；
- 删除后可从当前项目事实和设备本机缓存重建。

## 4. 编码器与降级

`SemanticEncoder` 支持 OpenAI-compatible `/v1/embeddings`。

设备模型连接角色：

```text
text       小镜语言解释 / 受限规划
vision     可选视觉增强
embedding  语义检索编码
```

当前配置优先级：

1. `MIRRORORDER_EMBEDDING_*` 环境变量；
2. 设备本地 `model-connections.json` 的 `embedding`；
3. 未配置时关闭向量路径，只使用文本召回。

约束：

- 文档向量记录 encoder identity；
- 查询只比较兼容 identity 的向量；
- 模型变化后在后续 refresh 重新编码；
- endpoint 失败时搜索仍应退回关键词路径；
- 不生成 fake embedding。

模型 Provider / Base URL / API Key 的用户入口属于 **全局设置 → 外部 / 自定义模型连接**，不属于小镜 Drawer。Team Web 不获得这些连接信息。

## 5. 混合召回

`SemanticSearcher` 使用：

```text
query
  ├─ FTS / trigram / keyword recall
  └─ same-encoder vector recall（可用时）
        ↓
      rank fusion
        ↓
visual / speech / slate evidence
```

融合分数只是 retrieval ranking，不是审核置信度、Review placement confidence 或 Editorial confidence。

结果保留 provenance，例如：

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

Team Web / Agent 通过 `safe_search_payload()` 隐去 provider、模型名和内部刷新细节。

## 6. 当前产品入口

### ⌘K / Ctrl+K

项目级“找素材”只有一个主要入口：**语义搜索 Palette**。

它不是项目 Tab，也不单独占一个 Production Page。结果可以打开对应 Take / 对白时间，但不会写 Review、Slate、Editorial 或 Timeline authority。

### 小镜

小镜是右侧 contextual drawer。它不再包含 Provider / API Key 配置，也不复制一套“找素材”页面。

小镜回答项目问题时使用同一 `SemanticSearcher` 作为 grounding：

```text
用户问题
  → semantic retrieval
  → top visual / speech / slate evidence
  → project / attention 作为次级上下文
  → 语言模型或确定性证据摘要
```

没有召回证据时必须明确证据不足，不能用常识补写素材内容。

## 7. 后台刷新与状态中心

生产任务完成后的语义刷新属于真实后台工作，必须进入全局 **状态中心**，不能再以不可见 daemon thread 运行。

相关生产任务完成后会提交 durable：

```text
semantic_index
```

当前行为：

- 使用 source task 的 task id 形成稳定 idempotency key；
- 可按受影响 group 做增量刷新；
- visual / speech / slate 分阶段更新；
- 状态中心显示等待资源、进度、完成、失败、取消和重试；
- 同一 logical task 的旧失败 attempt 不再永久污染“需要注意”。

`content_fingerprint` 用于避免未变化文档重复写入；已有同模型向量在 encoder 暂时不可用时可以保留。

### 当前按需 refresh 兼容路径

本机 ⌘K 搜索和小镜回答目前仍保留 request-time `refresh=True`，用于避免刚写的场记或证据在 durable task 尚未完成时完全不可见。这个 refresh 仍然只读且不会触发 VLM / ASR。

如果以后默认启用本地 embedding，必须进一步拆开：

```text
便宜的 document refresh
        ↓ 立即可关键词搜索
后台 incremental embedding fill
        ↓ partial / complete hybrid retrieval
```

不得让第一次 ⌘K 因模型下载、启动或整库向量化而长时间阻塞。

## 8. API / CLI / Agent

Host / App：

```text
GET /api/v1/projects/{project_id}/semantic-search?q=...&limit=16
```

来源过滤：

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

Agent 必须有 `read` scope。`AgentToolRegistry.search_project_semantics()` 是只读 helper，不加入模型可执行生产动作的 `SAFE_ACTIONS`。

## 9. 红线

语义链不得：

- 写 `review.json`；
- 写 `editorial.json`；
- 写 `auto_decisions.json`；
- 产生自动 Reject / Best；
- 把 Audit 结论当素材语义真值；
- 把媒体绝对路径写进语义文档；
- 因为搜索触发全项目 VLM / ASR；
- 在 Team Web 暴露 API Key、模型地址、模型名或本机路径；
- 把 retrieval score 展示成审核可信度。

## 10. 后续升级顺序

当前接口已经把 encoder、document store 和 search 层解耦。后续升级优先：

1. 用真实项目建立中文编辑式 retrieval benchmark；
2. 接入第一方 managed local embedding runtime，并保持外部 OpenAI-compatible override；
3. 把 document refresh 与 embedding fill 完全异步拆开；
4. 记录 index/query latency、vector document count、维度与内存；
5. 只有当前 SQLite + 本地扫描在真实规模下成为瓶颈时，再评估 sqlite-vec / HNSW；
6. reranker、额外 sparse/ColBERT 路径和独立向量服务都不是当前 V1 前提。

任何 embedding 模型名称、维度或“准确率”都必须来自当前 benchmark / model provenance，不写成未经验证的产品承诺。
