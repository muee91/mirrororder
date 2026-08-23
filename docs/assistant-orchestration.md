# 镜序助理：生产编排与模型接入

镜序助理不是悬挂在工作台旁边的聊天机器人。它是 MirrorOrder Host 上方的一层**受限生产编排器**：读取项目事实，识别值得处理的问题，调用镜序已经存在的分析能力，并把需要人的判断主动送回看片工作流。

核心原则：

> **AI 接管重复劳动和问题发现，不接管人工审核与最终创意权。**

## 1. 架构

```text
Project / Task events
        ↓
AssistantOrchestrator
        ↓
AgentToolRegistry
        ↓
┌──────────────┬───────────────┬────────────────┐
│ deterministic│ local/remote  │ optional LLM   │
│ Host facts   │ Audit / VLM   │ plan / explain │
└──────────────┴───────────────┴────────────────┘
        ↓
assistant.json / assistant.v1
        ↓
镜序助理
  → 主动提醒
  → 低置信看片队列
  → 人物候选
  → 素材问题
        ↓
Human Review / Editorial Decision
```

`assistant.json` 是可重建的派生状态，不是审核权威。它不能替代 `review.json`、`editorial.json` 或 `auto_decisions.json`。

## 2. 触发与算力边界

以下 Host 任务完成后重新整理助理状态：

- `prepare_project`
- `incremental_analyze`
- `auto_resolve`
- `transcribe`
- `audit`
- `identity_index`
- `evidence_extract`

前四类完成后允许执行受限后续动作；Audit、身份识别和证据提取完成后只刷新问题队列，防止递归昂贵任务。

视觉能力已经由用户明确启用时，助理允许在主分析结束后自动提交**最多 24 个高优先疑难 Take** 的 `priority audit`。审计任务幂等键包含 analysis revision；同一分析版本、同一组目标不会因为轮询重复排队。

其它受限工具的上限：

```text
extract_visual_evidence   最多 12 Take / 调用
index_unknown_identities  最多 16 Take / 调用
```

身份索引继续遵守 identity cache：人工已确认的 identity 不因助理的指定 Take 调用而重新计算。

镜序不会因为“AI 已启用”就全项目跑 VLM、人脸或声纹。

## 3. Audit freshness：映射判断与画面事实分开

Audit 现在区分两类 freshness：

```text
visual freshness
  由 material_index / script / matches 的 analysis revision 决定

mapping freshness
  由当前 review.json + auto_decisions.json 计算出的 effective mapping 决定
```

原因是两类证据生命周期不同。

例如某个 Take 已经审计出：

```text
A = closeup
B = medium
```

之后剪辑人员把该 Take 从剧本 S12 改到 S18：

- A/B 的景别仍然是当前素材事实，可以继续复用；
- “AI 是否同意当前剧本归集”、角色候选、mapping issue、rough-cut guidance 已经基于旧归集，必须标记 `mapping_stale`；
- 助理不能把旧 judge 当作当前审计继续压掉新的 priority audit。

因此 review.v1 中允许：

```text
audit_state.stale = true
audit_state.mapping_stale = true
audit_state.visual_current = true
```

同时继续保留 `shot_intelligence`。

当 analysis revision 本身变化时，旧画面证据也不再作为 current visual evidence。

## 4. Agent Tool Registry

模型没有文件系统控制权。Assistant Orchestrator 只能执行 MirrorOrder 自己注册的 allowlist 工具。

当前可执行工具：

```text
run_priority_audit
extract_visual_evidence
index_unknown_identities
collect_learning_cases
noop
```

只读能力：

```text
inspect_project
inspect_take
list_attention_groups
model_status
failure_patterns
```

明确禁止：

- 直接写 `review.json`
- 直接写 `editorial.json`
- 直接写或伪造 `auto_decisions.json`
- 自动 Best / Reject
- 覆盖人工 placement / assignment
- 修改原始媒体
- 修改原始 FCPXML
- 修改全局匹配阈值
- 直接部署模型提出的算法补丁

任何没有进入 allowlist 的 tool name 都必须拒绝。

## 5. Model Registry

统一入口是 `ModelRegistry`，公开契约为 `models.v1`：

```text
production_rescue   生产映射链受限文本二审
vision              本地或用户明确连接的远端视觉能力
multimodal_audit    Shadow Audit 使用的多模态能力
assistant_language  自然语言解释与受限规划
```

`assistant_language` 选择顺序：

1. `MIRRORORDER_ASSISTANT_MODEL_*` 显式环境变量；
2. App 保存的本机语言模型连接；
3. production rescue LLM；
4. 已启用本地视觉模型，作为 text-only fallback；
5. 无语言模型。

因此当前只有本地小参数视觉模型时，镜序仍然可以：

- 做 per-clip 景别判断；
- 做 Shadow Audit；
- 输出技术质量、连续性与 coverage 线索；
- 主动挑出最值得审计的低置信 Take；
- 用户明确点击“让助理规划”时复用本地模型做简短 JSON 规划。

没有语言模型时，问题队列和优先级继续由确定性规则生成。

## 6. App 模型连接

“镜序助理 → 模型连接”有两个可选连接。

### 语言模型

```text
base_url
model
api_key
```

用于自然语言解释和受限工具规划。

### 增强多模态

同样使用 OpenAI-compatible `chat/completions`：

```text
base_url
model
api_key
```

只有用户明确启用这个连接，视觉 Provider 才会使用它；否则继续使用已经启用的本地视觉模型或保持无视觉模型状态。远端多模态启用后，Audit 可能把**有限抽样 JPEG 帧**发送到该端点；原始视频不会由该 Provider 上传。

环境变量仍然高于 App 保存连接。兼容旧行为：本地视觉已启用且只设置 `MIRRORORDER_VISION_MODEL` 时，它仍表示替换本地模型，不会被误判为远端连接。

本机配置位置：

```text
~/Library/Application Support/MirrorOrder/model-connections.json
~/Library/Application Support/MirrorOrder/model-secrets.json
```

`model-secrets.json` 尽可能以 `0600` 权限保存。

API Key 不得进入：workspace、project.toml、`assistant.json`、`audit.json`、`review.json`、`editorial.json`、`auto_decisions.json` 或 Team Web / Agent 公开 payload。

## 7. 语言模型规划

语言模型不是自由 Agent。它只能返回结构化计划，例如：

```json
{
  "briefing": "有两组素材值得先补证据",
  "actions": [
    {
      "tool": "extract_visual_evidence",
      "arguments": {"group_ids": ["G_001"]}
    },
    {
      "tool": "index_unknown_identities",
      "arguments": {"group_ids": ["G_001"], "kind": "speaker"}
    }
  ],
  "questions": [
    {"group_id": "G_001", "text": "请看片确认是否为补拍"}
  ]
}
```

Host 会再次验证 tool name 与参数；每次计划最多执行 2 个动作。

**显式模型计划一旦成功生成，就拥有当前 cycle。** Host 不会在计划后面再偷偷追加第三个 deterministic priority audit。只有没有得到可用模型计划时，确定性 auto-audit 才作为 fallback。

自动模型规划默认关闭。只有：

- App 用户点击“让助理规划”；或
- Host 明确设置 `MIRRORORDER_ASSISTANT_AUTO_PLAN=1`

才允许调用语言模型做规划。

自动 priority audit 不依赖语言模型；它是 Host 的确定性、bounded fallback 调度。

## 8. 主动问题队列

问题按生产风险排序，而不是做“AI confidence 排行”：

```text
100  人工归集 vs 当前算法冲突
 96  AI Audit 不同意算法
 95  当前 Host 缺媒体
 90  unresolved
 86  needs_review
 84  no_candidate
 82  top candidates 分差过小
 66  技术质量 / continuity 风险
 38  角色候选待确认
```

用户主要看到：

```text
看片
判断归集
确认人物
```

Host `assistant.v1` 是主动提醒与问题队列的来源；前端本地问题生成只保留为 Host API 不可用时的降级路径。

## 9. 人物与多机位

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

B 机拍王强而现场说话的是李雪不是矛盾。没有可靠视听绑定时，不得因为台词属于李雪就把 B 机 face 命名为李雪。

人工确认过的 face / speaker identity 不重复计算或自动覆盖。

## 10. Agent API

外部 Codex / Agent 与镜序助理不是同一权限主体，但共用安全边界。

Host project route：

```text
/api/agent/v1/projects/{project_id}/...
```

Gateway workspace route：

```text
/api/agent/v1/workspaces/{workspace_id}/projects/{project_id}/...
```

Bearer scope：

```text
read
analyze
propose
```

新增：

```text
GET  /api/agent/v1/projects/{project_id}/assistant
POST /api/agent/v1/projects/{project_id}/assistant/cycle
```

`assistant/cycle` 需要 `analyze` scope。它仍只能调用 Assistant allowlist，不能直接写人工审核。

App 镜序助理面板有明确 **Agent API** 入口显示 project route、capabilities route 和权限边界；Team Web 不展示这些制作配置。

## 11. 算法学习与人工修正

`learning_cases.jsonl` 是只供离线 replay / eval / 算法研发使用的派生数据，生产 matcher 永远不读取它。

Audit 完成时会刷新 learning dataset。现在人工 `review.json` 写入成功后也会做一次廉价重建，因此：

```text
旧算法预测
↓
剪辑人员人工修正 placement / assignment
↓
learning_cases.jsonl 立即以最新人工范围作为 human_expected
```

这一步不会运行 VLM，也不会改自动结果，只重建 JSONL 派生数据和助理问题队列。

正确升级链：

```text
human override / audit disagreement
→ learning_cases.jsonl
→ failure pattern clustering
→ candidate algorithm patch
→ offline replay / regression
→ 人工批准 promotion
→ 下一版 production algorithm
```

禁止：

```text
LLM发现问题 → 直接修改production matcher → 自动部署
```

## 12. App / Web 边界

### App Production

可以：

- 查看主动问题并直达看片 / 归集 / 人物库；
- 查看本地/远端视觉、语言模型和 Agent API 是否可用；
- 配置设备本地语言模型与可选多模态连接；
- 点击“让助理规划”；
- 与镜序助理做当前项目范围内问答。

### Team Web Review

安全 `assistant.v1` 只包含：

- summary
- items
- revision / updated_at

不包含：

- App 助理聊天记录
- provider / 模型配置
- API Key
- Host runtime / 模型路径
- Agent token 管理
- 自动生产任务控制

外部 Agent 的 assistant read 同样不读取 App 助理聊天记录。

## 13. 后续工具优先级

Assistant Orchestrator 已形成真正控制平面。下一阶段重点不是增加闲聊，而是增加新的第一方安全工具：

1. `build_coverage_graph(scene_id)`
2. `find_continuity_risks(scene_id)`
3. `evaluate_algorithm_candidate(version)`，只允许离线 replay
4. Rough Cut Planner，以 Coverage Graph + Editorial Decision 为输入

每增加一个工具，都必须单独定义写入边界、算力上限和回归测试。
