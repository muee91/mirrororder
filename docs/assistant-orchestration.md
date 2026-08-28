# 小镜：生产编排与项目问答

> 当前 contract：`assistant.v1`。
>
> 小镜是 MirrorOrder Host 上方的**受限生产编排与解释层**。它读取已有项目事实和证据、发现需要人工关注的问题，并通过 allowlist 工具请求有限的分析动作。它不是 Review、Slate、Editorial 或 Timeline authority。

核心原则：

> **AI 接管重复劳动和问题发现，不接管人工审核与最终创意权。**

## 1. 产品入口

小镜只有一个用户入口：**当前项目右侧 contextual drawer**。

当前 Drawer 负责：

- 关注事项；
- 当前项目范围内问答；
- 重新检查当前项目。

它不负责：

- Provider / Base URL / API Key 配置；
- 独立“找素材”页面；
- Agent token / Host runtime 调试；
- 最终审核或剪辑决策写入。

对应入口已经分开：

```text
⌘K / Ctrl+K          → 项目语义搜索
小镜 Drawer           → 项目事项 + grounded 问答
全局设置              → 本地模型 / 外部或自定义模型连接 / 高级诊断
状态中心              → durable background tasks
团队审阅              → Team Web collaboration
```

同一能力不得重新在小镜里长出平行入口。

## 2. 架构

```text
Project / Task events
        ↓
AssistantOrchestrator
        ├─ deterministic project facts
        ├─ semantic retrieval grounding
        ├─ Audit / perception / identity evidence
        └─ optional language model
        ↓
AgentToolRegistry allowlist
        ↓
assistant.json / assistant.v1
        ↓
小镜
  ├─ 需要判断
  ├─ 制作提醒
  ├─ 人物线索
  └─ 项目问答
        ↓
Human Review / Slate / Editorial workflow
```

`assistant.json` 是可重建派生状态，不替代：

- `review.json`；
- Script Supervisor / Slate；
- `editorial.json`；
- `auto_decisions.json`；
- Rust Timeline state。

## 3. Authority 边界

小镜不得：

- 直接写 `review.json`；
- 覆盖人工 placement / assignment；
- 写或伪造 Final Editorial Decision；
- 把 Slate `NG` 转成 Editorial Reject；
- 把 Exclusion 转成 Reject；
- 自动产生 Best / Reject；
- 直接修改 Rust Timeline；
- 修改原始媒体或原始 FCPXML；
- 把 retrieval / Audit score 当作人工 confidence；
- 用常识补写项目里不存在的画面、对白或场记事实。

统一权限链：

```text
evidence → proposal / explanation → human confirmation → authority
```

## 4. 触发与算力边界

以下生产任务完成后可刷新小镜派生状态：

- `prepare_project`
- `incremental_analyze`
- `auto_resolve`
- `transcribe`
- `audit`
- `identity_index`
- `evidence_extract`

主分析类任务完成后可以触发受限的后续分析；Audit、身份识别和证据提取主要用于刷新问题队列，避免递归昂贵任务。

当前 allowlist 的 bounded 工具包括：

```text
run_priority_audit
extract_visual_evidence
index_unknown_identities
collect_learning_cases
noop
```

典型上限继续保持：

```text
priority audit              ≤ 24 Take
extract_visual_evidence     ≤ 12 Take / 调用
index_unknown_identities    ≤ 16 Take / 调用
```

镜序不会因为启用了 AI 就无边界地全项目运行 VLM、人脸或声纹。

## 5. Agent Tool Registry

模型没有文件系统或通用 shell 控制权。

只读能力包括：

```text
inspect_project
inspect_take
list_attention_groups
model_status
failure_patterns
search_project_semantics
```

生产动作必须进入明确 allowlist；未知 tool name 或越界参数由 Host 拒绝。

`search_project_semantics()` 是 read-only helper，不因为被模型调用就获得 Review、Slate、Editorial 或 Timeline 写权限。

## 6. Audit freshness

Audit 必须把**画面事实 freshness**与**mapping freshness**分开。

例如某 Take 已记录：

```text
A = closeup
B = medium
```

之后人工把它从剧本 S12 改到 S18：

- A/B 景别仍可能是当前媒体事实；
- 基于旧 mapping 的 judge / advice 必须视为 stale；
- stale mapping 不能继续冒充当前归集判断；
- 当前媒体派生视觉事实可以在其自身 revision 仍有效时继续显示。

Audit 是反方证据/建议，不写 Review 或 Final Editorial Decision。

## 7. 模型与连接入口

模型能力由设备本地配置与 `ModelRegistry` / runtime projection 统一暴露，主要角色包括：

```text
text       小镜语言解释 / 受限规划
vision     可选视觉增强 / Audit evidence
embedding  语义检索编码
```

用户配置入口是：

> **全局设置 → 本地模型 / 外部或自定义模型连接**

不是“小镜 → 模型连接”。

当前设备连接可以保存：

```text
provider
base_url
model
api_key secret
```

其中 API Key 必须保持设备本地，不进入：

- workspace；
- project.toml；
- `assistant.json`；
- `audit.json`；
- `review.json`；
- `editorial.json`；
- `auto_decisions.json`；
- Team Web / Agent 公开 payload。

设备本地连接和 secret 文件位于 MirrorOrder Application Support 数据目录。公开 API 只暴露 `has_api_key` 等安全状态，不回显 secret。

## 8. 小镜 Grounding

小镜回答用户问题时优先使用项目语义检索：

```text
用户问题
  ↓
SemanticSearcher
  ├─ visual evidence
  ├─ speech evidence
  └─ slate evidence
  ↓
project / attention 作为次级上下文
  ↓
optional language model
  或确定性证据摘要
```

系统 contract 要求：

- 优先引用检索到的项目证据；
- 没有证据时明确说证据不足；
- ASR 允许存在转写误差；
- 多机位画面中的人不等于正在说话的人；
- 场记“前半段”没有人工精确 I/O 时不能伪造秒数；
- 检索结果不能自动升级成 Best / Reject / placement / Editorial Decision。

没有可用语言模型时，小镜仍可用确定性方式汇总最高相关的现有证据，而不是把整个产品降级成“模型未连接”。

语义检索的索引、刷新和 Status Center contract 见 `semantic-retrieval.md`。

## 9. 语言模型规划

语言模型不是自由 Agent，只能返回受约束结构化计划。例如：

```json
{
  "briefing": "有两组素材值得先补证据",
  "actions": [
    {
      "tool": "extract_visual_evidence",
      "arguments": {"group_ids": ["G_001"]}
    }
  ],
  "questions": [
    {"group_id": "G_001", "text": "请看片确认是否为补拍"}
  ]
}
```

Host 会再次校验 tool name、参数、目标范围和动作数量。

当前 Desktop 的“重新检查”属于用户显式触发的项目检查入口；UI 不需要暴露“Agent planner”工程概念。即使模型参与规划，用户看到的仍应是项目事项与制作语言。

## 10. 主动问题队列

问题按生产风险排序，不做“AI confidence 排行”。典型优先级来源包括：

- 人工归集与当前算法冲突；
- Audit disagreement；
- 当前 Host 缺媒体；
- unresolved / no candidate；
- 候选竞争；
- 技术质量 / continuity 风险；
- 人物候选待确认。

用户主要看到：

```text
需要判断
制作提醒
人物线索
```

前端不应把内部 failure taxonomy、模型名或 raw score 当主文案。

## 11. 人物与多机位

角色推断只能作为候选：

```text
speaker cluster
+ ASR 对白
+ 已可靠归集的剧本范围
+ 剧本 speaker
→ role_suggestion (requires_confirmation)
```

多机位必须保持：

```text
speaker != visible_actor
```

人工确认过的 face / speaker identity 不得被普通重跑自动擦除。

face/speaker identity embedding 与 text semantic embedding 是不同数据空间，也不得因为都叫 embedding 就混为同一 authority 或索引。

## 12. Team Web / Agent API 边界

Team Web 可以读取安全的 assistant projection，例如：

- summary；
- items；
- revision / updated_at。

不包含：

- App 小镜聊天记录；
- provider / 模型连接；
- API Key；
- Host runtime / 模型路径；
- Agent token 管理；
- Final Editorial Decision authority；
- Production Timeline control。

外部 Agent 使用受限 Bearer scope：

```text
read
analyze
propose
```

assistant cycle 即使由 Agent 请求，也只能调用 allowlist，不能直接写人工审核。

Agent route / capability 等诊断信息属于设置/高级工程入口，不需要占据小镜 Drawer。

## 13. 学习闭环

`learning_cases.jsonl` 只用于离线 replay / eval / 算法研发，production matcher 不读取它作为在线自我修改规则。

正确链路：

```text
human override / audit disagreement
→ learning_cases.jsonl
→ failure pattern clustering
→ candidate algorithm patch
→ offline replay / regression
→ human-approved promotion
→ 下一版 production algorithm
```

禁止：

```text
LLM发现问题 → 直接修改 production matcher → 自动部署
```

新增 Assistant 工具时必须分别定义：

1. 输入 evidence；
2. 写入 authority；
3. 算力上限；
4. cancellation / retry；
5. Team Web / Agent 暴露范围；
6. 回归测试。
