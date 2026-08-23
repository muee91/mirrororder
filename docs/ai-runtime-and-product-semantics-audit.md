# 镜序 AI Runtime、Agent 与产品语义审计

> 状态：2026-08-24
>
> 目的：回答三个工程问题：
>
> 1. 当前镜序本地 AI 栈相对 Seelyn 到底强在哪里、弱在哪里；
> 2. 当前本地模型是否足以承担 Agent / CLI 调度；
> 3. 仓库里的功能是否已经形成用户可理解的产品语义，哪些能力仍只存在于代码或高级接口中。
>
> 这不是市场对比文案。没有 benchmark 支撑的地方不使用“全面领先”“准确率更高”等表述。

---

## 1. 结论先行

### 1.1 不能把“本地模型更新”直接等价为“整个系统强于 Seelyn”

镜序当前默认本地视觉模型是：

```text
Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M
```

它由本机 `llama-server` 通过回环 HTTP 提供视觉和可选 text fallback。

对镜序当前限定任务而言，这个模型已经足够承担：

- 少量抽样帧的结构化画面描述；
- 疑难 Take 的候选救援；
- Audit 的辅助视觉判断；
- 简短自然语言解释；
- 从很小的 allowlist 中选择 0–2 个生产动作；
- 严格 JSON schema 下的轻量计划。

但**目前没有数据可以证明 Qwen3-VL-4B Q4 在镜序真实素材上全面优于 Seelyn 的 `analysis-core.gguf + vision-proj.gguf`**。后者的准确模型参数在现有逆向文档里没有被可靠还原，只知道它是本地 Qwen-VL 深度视觉链。

更重要的是，Seelyn 的系统能力不是单个 VLM：它还把专用 GTE、快速视觉双塔、VAD/ASR/标点、片段级向量索引、以图搜图、素材集合和多个 NLE CLI 接口打包成了一套完整本地素材检索运行时。

因此当前判断必须拆开：

| 维度 | 当前镜序 | 当前判断 |
|---|---|---|
| 单个本地 VLM 的代际 / 通用理解潜力 | Qwen3-VL-4B Q4 | 很有竞争力，但未 benchmark，不能宣称稳赢 |
| 短剧后期领域语义 | 剧本、多机位、场记、人工权威、Coverage、粗剪、Editorial Decision | 镜序明显更深 |
| 通用本地素材语义检索完整度 | FTS + 可选 embedding；Take 级视觉/对白；无以图搜图 | 目前 Seelyn 更完整 |
| Agent 安全编排 | allowlist tools + scopes + proposal + human authority | 镜序结构更适合生产 Agent |
| NLE 一键交换完整度 | AppKit drag + FCPXML read-only + delivery manifest | 目前 Seelyn 覆盖面更广 |

**产品方向不应该是复制 Seelyn 的“本地素材库”全部功能，而是补齐镜序真正需要的语义基础设施后，把优势放在“剧本驱动的后期生产决策”上。**

---

## 2. 当前镜序 AI Runtime 矩阵

### 2.1 本地视觉 / 语言

```text
LocalVisionRuntime
  └─ llama-server
       └─ Qwen3-VL-4B-Instruct-GGUF:Q4_K_M
```

当前角色：

1. `VisionProvider` / `TakeSemanticProvider`
   - 抽样帧理解；
   - 结构化 visual evidence；
   - 不写人工审核。
2. `Audit`
   - 在高价值、歧义 Take 上做反方证据；
   - 不覆盖人工结论。
3. `AssistantLanguageModel`
   - 若没有独立 text model，可以复用本地 VLM 作为 text-only fallback；
   - 只输出严格 JSON / 简短说明。

这意味着镜序**没有要求 4B 模型同时成为“视觉模型 + 编程模型 + 自主操作系统”**。它只承担概率性理解；状态变化由 Host 的确定性代码完成。

### 2.2 ASR

ASR 是独立证据源，不让 VLM 代替听音频。

```text
media
  → ASR runtime
  → TranscriptStore
  → script alignment / candidates
  → semantic speech documents
```

这比让 VLM 在画面描述里同时猜 `speech_text` 更符合镜序的证据边界。

### 2.3 人脸 / 声纹

人脸与说话人 embedding 只属于设备本地感知层：

```text
Take
  ├─ face identity
  └─ speaker identity
      ↓
identity clusters
      ↓
人工命名 / 合并
```

身份候选不能自动变成角色事实，也不能成为 Editorial Decision。

### 2.4 语义 embedding

当前已经存在统一接口：

```text
SemanticEncoder
  └─ OpenAI-compatible /v1/embeddings
```

但**当前仓库还没有像 Seelyn `vector-zh` 那样随 App 打包一个固定的本地中文 embedding runtime**。

所以现在的状态是：

- FTS / trigram / LIKE fallback 可以完全离线工作；
- 配好本地或外部 embedding endpoint 后可运行 vector + keyword hybrid recall；
- 不能把“向量语义检索”描述为默认开箱即用的完全本地能力。

这是当前与 Seelyn 最大的 AI 基础设施差距之一。

---

## 3. 镜序与 Seelyn：正确的比较方式

### 3.1 Seelyn 当前强项

基于现有逆向文档，Seelyn 已经形成：

```text
visual_fast  → CLIP-like dual tower → material embeddings
visual       → Qwen-VL → segment descriptions → GTE embeddings
speech       → VAD → ASR → punctuation → speech segments
text query   → same GTE
image query  → fast visual embedding
              ↓
     vector + FTS hybrid recall
              ↓
         clip collection
              ↓
 Premiere / Resolve / FCP / Jianying
```

这套链路的特点是**泛素材库完整**：先把素材拆成可检索片段，再提供文字 / 图片 / 台词搜索和编辑器交换。

### 3.2 镜序当前强项

镜序不是“视频网盘 + AI 搜索”。当前领域链是：

```text
原始多机位素材 + 剧本 + 场记
        ↓
音频同步 / Take grouping
        ↓
ASR + known-text alignment
        ↓
剧本候选 / sequence alignment
        ↓
确定性自动归集
        ↓
仅对疑难 Take 使用视觉 / 模型救援
        ↓
Review mapping
        ↓
Individual Opinion
        ↓
Editorial Decision
        ↓
Coverage
        ↓
Rough Cut Plan
        ↓
Assembly Preview
        ↓
Delivery Semantics
        ↓
selection_manifest.v3
```

因此镜序比 Seelyn 更有价值的地方不是“VLM 多 1B 参数”，而是：

- 多机位是第一类对象，不是互不相关的视频文件；
- 剧本是结构化坐标系；
- 场记是高权重人工生产事实；
- 自动归集与创意选择被拆成两个轴；
- 团队意见与最终编辑决定被拆开；
- AI Audit 不等于人工结论；
- Coverage / Rough Cut / Assembly 都继承同一权威顺序；
- Delivery 不会把多数意见或 AI 直接变成 NLE 写入。

这已经是一套**后期生产语义系统**，而不只是素材检索系统。

---

## 4. 当前 4B 本地模型足够做 Agent 吗？

答案取决于“Agent”指什么。

### 4.1 足够：受限工具路由 Agent

当前模型足够尝试以下模式：

```text
用户意图
  ↓
读取 project context / semantic evidence
  ↓
LLM 返回严格 JSON
  ↓
从有限 allowlist 中选 0–2 个动作
  ↓
参数 schema 校验
  ↓
Host 执行确定性工具
  ↓
读取新状态
```

例如：

```text
“找一下门口回头的反应镜头”
  → semantic_search

“这几条归集为什么不确定？”
  → inspect / get_evidence

“把高风险 Take 再检查一下”
  → run_priority_audit

“这几条需要更多画面证据”
  → extract_visual_evidence
```

这种 Agent 的难点主要在**意图分类 + 参数填写**，不是长链代码推理。4B 模型配合 schema、低温度、小上下文和验证器可以胜任。

### 4.2 可以逐步验证：2–3 步生产规划

例如：

```text
发现缺乏证据
  → semantic / context read
  → extract evidence
  → wait/read result
  → propose next review focus
```

这类流程可以做，但需要正式 benchmark 才能提高自主度。

推荐门槛：

- tool selection exact match ≥ 98%；
- forbidden action rate = 0；
- JSON/schema first-pass ≥ 99%；
- 重复提交必须被 idempotency 挡住；
- 每次写操作前后都重新读取 revision；
- 任何 final editorial / Reject / source media mutation 都不属于模型权限。

### 4.3 不足，也不应该做：自由 Shell / 任意 CLI Agent

不建议设计：

```text
LLM
  → bash
  → 自己拼 script-organizer ...
  → 自己解释 stderr
  → 再决定下一条 shell
```

原因不只是 4B 模型“够不够聪明”：

1. shell 的攻击面和状态空间太大；
2. CLI 参数语法是实现细节，不应该成为模型的稳定产品 contract；
3. 生产系统需要 revision / idempotency / scope / audit；
4. 换模型后不应重新训练“怎么敲命令”；
5. 未来 CLI 重构不应该破坏 Agent。

**正确结构是：Agent 与 CLI 共享业务能力，但不共享 shell 权限。**

```text
                       ┌─ App UI
                       │
Business service verbs ├─ script-organizer CLI
                       │
                       └─ Agent Gateway / MCP tools
```

当前镜序已经沿这个方向实现：

- `script-organizer`：人 / 自动化脚本使用；
- `script-organizer-mcp`：Agent 使用；
- Agent Gateway：`read / analyze / propose` scope；
- 模型只能看到明确工具；
- 不存在 `shell / exec / run_cli` MCP tool。

### 4.4 当前 MCP / CLI 语义面

MCP 当前包括：

```text
capabilities
list_projects
project_context
search
semantic_search
get_evidence
submit_task
submit_proposal
```

其中：

- `search`：确定性名字 / 剧本 / 已有 ASR 文本搜索；
- `semantic_search`：画面 / 对白 / 场记 hybrid retrieval；
- `submit_task`：只允许 Host 受限任务；
- `submit_proposal`：只能提交人工待确认提案。

CLI 当前新增：

```text
script-organizer semantic-search <workspace> <project_id> <query>
  --limit 16
  --source visual
  --source speech
  --source slate
  --no-refresh
```

因此现在已经不存在“App 能搜，但 Agent / CLI 不知道这个能力”的断层。

---

## 5. 当前产品语义是否说得通？

### 5.1 主链已经基本闭环

当前最重要的数据权威可以整理成：

| 层 | 含义 | 能否自动写 | 是否创意最终权威 |
|---|---|---:|---:|
| 原始媒体 / media identity | 素材是什么 | 否 | 否 |
| Script | 剧本结构 | 人工输入 | 否 |
| Script Supervisor | 现场生产事实 | 人工 | 否 |
| ASR / perception / identity | 可重建证据 | 是 | 否 |
| match candidates | 算法候选 | 是 | 否 |
| auto_decisions | 自动剧本归集 | 是 | 否 |
| review placement | 人工剧本归集 | 人工 | 归集权威 |
| Individual Opinion | 个人 Best/Keep/Reject 意见 | 人工 | 否 |
| Editorial Decision | 最终编辑选择 | 人工 | 是 |
| Coverage | 派生覆盖状态 | 是 | 否 |
| Rough Cut Plan | 派生剪辑计划 | 是 | 否 |
| Assembly | 派生组接预览 | 是 | 否 |
| delivery.v1 | 最终交付选择解析 | 是，读取人工权威 | Delivery 权威投影 |

这套顺序是自洽的。

### 5.2 一个非常重要的语义优势

镜序现在已经明确区分：

```text
“这条素材对应剧本哪里？”
             ≠
“这条素材剪不剪？”
```

前者是 **mapping**，后者是 **editorial**。

因此：

- AI 可以高置信地确认剧本位置，但不能因此自动 Keep；
- Web 上三个人都选 Best，也不会多数票自动变成 Final；
- 场记写 NG 可以成为重要约束，但不自动写 Reject；
- Audit 反对当前算法，也只是要求复核；
- Assembly 遇到没有明确 Best 的位置会显示 `selection_pending`，而不是偷偷挑一条。

这比“一个 status 同时承担识别、审核、选片、导出”更适合专业后期。

---

## 6. 仍然存在的语义缺口

主链自洽不等于所有能力已经完成。当前至少有 6 个明确缺口。

### 6.1 语义视觉搜索粒度目前还是 Take 级

当前 `visual` semantic document 基本是一整个逻辑 Take 的描述：

```text
Take G1
  start = 0
  end   = Take duration
  description = 抽样帧综合描述
```

所以用户搜：

```text
“他推门后回头的那一秒”
```

目前可以找到正确 Take，但还不能保证定位到精确画面时间范围。

Seelyn 的深度视觉是 segment-level start/end，因此当前**精确视觉片段检索 Seelyn 更成熟**。

后续应该增加：

```text
visual_segment.v1
  group_id
  clip_id / media_id
  start / end
  representative_frame
  description
  extracted_text
  tags
  content_fingerprint
```

不要为了做 segment 强行全片 VLM；可以从 scene change / motion / ASR boundary 生成少量片段，再按预算分析。

### 6.2 speech semantic document 目前也偏 Take 级

底层 ASR 已经有 segment 时间戳，但当前 semantic index 把一个 Take 内文本合并成一条 speech document。

后续应直接建立 `speech_segment` 文档，让自然语言 / 精确台词搜索可以跳到 3.2–6.8 秒，而不只是整个 Take。

### 6.3 没有内置本地 embedding 模型

这是当前最需要补的基础能力。

目标不是固定照搬 GTE，而是满足：

- 中文短句 / 剧情描述 retrieval 强；
- ONNX / MLX / llama embedding runtime 至少一种可稳定打包；
- tokenizer + model version 固定 fingerprint；
- doc/query 同模型；
- Apple Silicon 上低驻留内存；
- 可商用许可明确；
- 完全离线。

在这个 runtime 落地前，产品不能把 semantic vector 宣称为默认完全本地。

### 6.4 没有 fast visual / image-to-image lane

当前镜序的视觉路线是：

```text
轻量 Tier0 本地视觉事实
  +
少量高价值 VLM semantic evidence
```

它非常适合剧本驱动项目，但对于：

```text
“找和这张截图构图相似的镜头”
```

还没有专门 image embedding。

如果要补，应该把它定义成**素材检索辅助通道**，而不是让它参与最终 review / editorial authority。

### 6.5 Delivery 只有 contract，正式 NLE Adapter 尚未完成

当前：

```text
Editorial Decision
  ↓
delivery.v1
  ↓
selection_manifest.json v3
```

已经自洽。

但：

```text
selection_manifest
  ↓
Final Cut / Premiere / Resolve
```

还没有正式安全 Adapter。

`organized.fcpxml` 目前仍保持原始 FCPXML byte-for-byte copy，这是正确的安全状态，但不能把它当作“最终编辑决定已经写进 FCP”。

### 6.6 Agent 的自动规划还没有正式可靠性 benchmark

架构是对的，但“4B 足够”目前仍属于工程判断，而非验收结论。

需要固定一套 tool-use test corpus 后，才能决定是否把 `MIRRORORDER_ASSISTANT_AUTO_PLAN` 从显式/保守模式提高自主度。

---

## 7. “代码存在但产品没有表现”的功能审计

不是所有 backend module 都必须有 UI。下面按性质分类。

### 7.1 A 类：真实存在的 Dormant Frontend，应该处理

#### `web/timeline.js` / `timeline_v3.js`

当前代码已经实现一个相当完整的：

- XML 时间线预览；
- 当前项目素材时间线；
- 加载外部 FCPXML；
- clip/resource 关联；
- 缩放 / 适配；
- 本机媒体 native drag。

但当前 `web/index.html` **没有加载 `timeline.js`**，而 `timeline.js` 又是 `timeline_v3.js + device_media.js + automation.js` 的 loader。

所以这套时间线 UI 当前实际上是 dormant code。

**建议：不要直接把旧 bundle 重新加载。**

原因：当前 App 已经有新的 Production 导航和 Assembly 模型。正确处理方式应该是：

```text
timeline_v3 有价值部分
  → 剪辑 / 时间线（App-only）
  → 只做 source/XML inspection + native drag
  → 与 Assembly 清晰区分
```

语义：

- `组接` = 镜序派生的 edit model；
- `时间线` = 外部 NLE/FCPXML 的结构检查器。

不要再让时间线以旧版 topbar 独立按钮出现。

#### `web/device_media.js`

它会显示：

```text
本机素材 42 / 45
```

但同样因为 loader 未加载而 dormant。

这项信息是有价值的，但更适合并入：

- 素材库页 header；
- 项目概览；
- 缺媒体 issue。

不需要再加一个永久 topbar badge。

#### `web/automation.js`

这是一套较早期的自动归集 / Host 控制 UI 增强，包括：

- 自动归集统计；
- “更换剧本”；
- prepare / auto-resolve task buttons；
- 自动状态 badge；
- polling。

它目前也 dormant。

其中部分语义已经被新版 Production / Assistant / task UI 覆盖。**不建议整包恢复**；应该逐项迁移仍有价值的能力，之后删除旧兼容 bundle。

### 7.2 B 类：Backend / Contract 完成，但产品表达还不完整

#### Delivery / NLE Adapter

状态：

```text
backend contract ✅
CLI export        ✅
App final decision ✅
NLE write adapter ❌
App delivery preview/export ❌
```

这是最明显的“下一阶段产品化”能力。

#### Agent token / Agent access management

当前：

- `agent-token-create` CLI 已有；
- Agent Gateway / MCP 已有；
- App 助理里有 Agent API 信息；
- 没有完整 App token 生命周期 UI。

如果 Agent 是开发者 / 自动化高级功能，这个状态可以接受；如果将来要作为正式产品能力，就应在 App Settings 增加：

```text
Agent Access
  token name
  scopes
  projects
  expiry
  revoke
  recent audit
```

Web 不应管理这些权限。

#### Semantic embedding connection

当前 App WebView 的助理高级区可以配 embedding endpoint，但 native “本地智能”设置还没有统一展示这个 runtime。

正式打包本地 embedding 后应该收归 native settings，不需要普通用户理解 endpoint。

### 7.3 C 类：没有独立 UI 是正确的

这些模块不应该为了“代码有表现”而创建页面：

- `known_text_alignment.py`
- `source_descriptor.py`
- `delivery_semantics.py` resolver 本体
- `review_read_model.py`
- `workspace_db.py`
- `resource_scheduler.py`
- compatibility wrappers / legacy adapters
- `learning_dataset.py` 的原始 JSONL

它们属于基础设施或派生层。

### 7.4 Audit 没有独立“大面板”也是合理的

Audit 的产品语义是：

```text
反方证据 / 风险提示
```

而不是：

```text
第二套审核系统
```

因此让 Audit 通过：

- 待处理；
- Take Inspector；
- 助理提醒；
- Rough Cut / Assembly issue；

间接表现，比单独做一个“AI Audit 控制台”更符合镜序产品原则。

---

## 8. 当前功能表达矩阵

| 能力 | Backend | App | Team Web | CLI | MCP / Agent | 状态 |
|---|---:|---:|---:|---:|---:|---|
| 项目 / 素材绑定 | ✅ | ✅ | 只读 | ✅ | read | 完整 |
| 多机位同步 | ✅ | ✅任务 | 只读结果 | ✅ | submit_task | 完整 |
| ASR | ✅ | ✅任务/结果 | 只读 | 间接 prepare | submit_task | 完整 |
| 剧本匹配 / 自动归集 | ✅ | ✅ | ✅结果 | ✅ | task/read | 完整 |
| 场记 | ✅ | ✅ | 审阅可见 | — | 只读上下文 | 完整 |
| 人脸 / 声纹 | ✅ | ✅ | ✅查看 | — | bounded task | 基本完整 |
| AI Audit | ✅ | 间接 | 间接 | — | bounded task | 语义正确 |
| Individual Opinion | ✅ | 可读 | ✅写 | — | 禁止直接写 | 完整 |
| Editorial Decision | ✅ | ✅写 | 只读 | — | 禁止 | 完整 |
| Coverage | ✅ | ✅ | 派生只读 | — | — | 完整 |
| Rough Cut | ✅ | ✅ | 派生只读/按边界 | — | — | 完整 |
| Assembly | ✅ | ✅ | — | — | — | 完整预览 |
| 语义找素材 | ✅ | ✅ | 不暴露高级模型 | ✅ | ✅ read | 基本完整 |
| 精确视觉片段定位 | Take 级 | Take 级 | — | Take 级 | Take 级 | 待升级 |
| 以图搜图 | ❌ | ❌ | ❌ | ❌ | ❌ | 未实现 |
| 内置本地 embedding | ❌ | endpoint 配置 | — | endpoint | read | 待实现 |
| Delivery Manifest | ✅ | Final影响结果 | 只读 final | ✅ export | 禁止 final write | Contract 完成 |
| NLE Delivery Adapter | ❌ | ❌ | ❌ | ❌ | ❌ | 下一阶段 |
| XML 时间线检查器 | 纯前端代码 | dormant | 不应开放 | — | — | 需迁移/清理 |
| Agent Access 管理 | ✅ | 信息级 | ❌ | ✅ | 本体 | 高级功能待产品化 |

---

## 9. 下一阶段优先级

### P0 — 先让语义搜索真正“本地开箱即用”

1. 选定本地中文 embedding runtime；
2. 固定 tokenizer/model fingerprint；
3. App 首次按需准备；
4. 用 200–500 条短剧检索 query 建 recall benchmark；
5. 搜索结果记录来源，但不显示内部 vector score。

### P1 — 片段粒度

1. speech segment documents；
2. visual segmentation；
3. 每段代表帧；
4. search result 精确 start/end；
5. 点击结果直接 seek 到片段。

这一步完成后，镜序才能在“自然语言找具体镜头”上和 Seelyn 做直接质量对比。

### P1 — Final Cut Delivery Adapter

1. `delivery.v1` → immutable delivery plan；
2. 独立 FCPXML fixture；
3. Rating / Keyword / range mapping；
4. output `mirrororder-delivery.fcpxml`；
5. round-trip；
6. Final Cut 真机 import；
7. App 才出现“导出到 Final Cut Pro”。

### P2 — Agent tool-use benchmark

建立固定场景：

```text
read-only questions
semantic retrieval
missing media
mapping conflict
need audit
need evidence
identity unknown
proposal creation
forbidden review write
forbidden final decision
forbidden source mutation
```

记录：

```text
tool accuracy
argument accuracy
schema pass
forbidden action
unnecessary action
retry count
latency
```

只有 benchmark 通过后才增加自动规划步数。

### P2 — 清理 Dormant Frontend

不要直接恢复 `timeline.js` loader。

执行：

1. 把 XML/source timeline 的价值部分移到新版 Production `剪辑 / 时间线`；
2. 把 device media 状态移入 `素材库 / 概览`；
3. 对照新版 UI 迁移 automation.js 仍缺的操作；
4. 删除旧 loader 与不再使用的重复 UI。

---

## 10. “比 Seelyn 强”应该如何验收

最终不要比较模型文件大小，而比较真实任务。

### Benchmark A：视觉证据

100–300 个真实短剧 Take：

- 主体 / 动作 / 道具正确率；
- OCR；
- 景别；
- hallucination rate；
- JSON schema pass；
- 每 Take 推理时间 / 峰值内存。

### Benchmark B：素材检索

人工标注 query → relevant segment：

- Recall@1 / @5 / @10；
- MRR；
- keyword-only；
- vector-only；
- hybrid；
- exact speech timestamp hit；
- visual semantic timestamp hit。

### Benchmark C：Agent

200+ 用户意图：

- 工具选择；
- 参数；
- 是否应该 noop；
- forbidden action = 0；
- 是否正确要求人工判断；
- 多步任务是否读取最新 revision。

### Benchmark D：后期有效性

真实项目：

- 自动归集正确率；
- 人工待处理比例；
- 每集人工归集耗时；
- 找镜头平均耗时；
- Coverage 缺口发现率；
- Rough Cut 需要推翻的比例；
- NLE import 成功率。

**如果镜序在 D 上显著优于 Seelyn，即使某个通用图像 embedding benchmark 不占优，它仍然是更强的短剧后期系统。**

---

## 11. 当前最终判断

### 本地模型

**足够作为镜序当前 bounded AI runtime；没有证据足以宣称单模型全面击败 Seelyn。**

### Agent

**足够做受限工具 Agent；不应该也不需要做自由 shell Agent。**

当前 `MCP → Agent Gateway → Host service` 的安全结构应该继续保留，CLI 与 MCP 共享能力语义即可。

### 产品语义

**主链已经自洽，而且“mapping / opinion / final decision / delivery”分层是镜序最重要的架构优势。**

### 还没有完成的部分

当前最值得投入的不是再换一个更大的 VLM，而是：

```text
内置 embedding
→ segment-level retrieval
→ NLE Delivery Adapter
→ Agent benchmark
→ dormant frontend 收口
```

这四项完成后，镜序的 AI 链会从“架构上比素材库更适合后期”进入“用户实际操作上也能稳定体现这种优势”的阶段。
