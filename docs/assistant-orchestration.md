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
│ deterministic│ local vision  │ optional LLM   │
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

`assistant.json` 是可重建的派生状态，不是审核权威。它可以被重新生成；任何时候都不能替代 `review.json`、`editorial.json` 或 `auto_decisions.json`。

## 2. 什么时候触发

当前第一版在以下 Host 任务完成后重新整理助理状态：

- `prepare_project`
- `incremental_analyze`
- `auto_resolve`
- `transcribe`
- `audit`
- `identity_index`
- `evidence_extract`

前四类任务完成后，助理可以执行受限的后续动作；Audit、身份识别和证据提取完成后只刷新问题队列，避免形成递归昂贵任务。

当本机视觉模型已经由用户明确启用时，助理允许在分析结束后自动提交**最多 24 个高优先疑难 Take** 的 `priority audit`。已经有当前分析版本 Audit 证据的 Take 不重复计算；任务幂等键同时包含 analysis revision，分析内容变化后才允许产生新审计。

助理不会因为“AI 已启用”就全量扫描所有素材。

## 3. Agent Tool Registry

模型没有文件系统控制权。Assistant Orchestrator 只能执行 MirrorOrder 自己注册的工具。

第一版可自动执行的工具只有：

```text
run_priority_audit
collect_learning_cases
noop
```

同时存在只读能力：

```text
inspect_project
inspect_take
list_attention_groups
model_status
failure_patterns
```

任何没有进入 allowlist 的模型动作都必须拒绝。

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

## 4. 模型注册表

统一入口是 `ModelRegistry`，公开契约为 `models.v1`。

角色：

```text
production_rescue
  生产映射链中的受限文本二审

vision
  本地或远端视觉能力

multimodal_audit
  Shadow Audit 使用的多模态能力

assistant_language
  镜序助理的自然语言解释与受限规划
```

### 当前模型优先级

`assistant_language` 按以下顺序选择：

1. `MIRRORORDER_ASSISTANT_MODEL_*` 显式环境变量；
2. App 保存的本机语言模型连接；
3. 已配置的 production rescue LLM；
4. 已启用的本地视觉模型，作为 text-only fallback；
5. 无语言模型。

因此当前只安装本地小参数视觉模型时，镜序仍然可以：

- 做 per-clip 景别判断；
- 做受限 Shadow Audit；
- 输出素材质量、连续性和 coverage 线索；
- 主动挑出最值得审计的低置信 Take；
- 在用户明确要求“让助理规划”时复用本地模型做简短文本规划。

没有语言模型时，问题队列和优先级仍由确定性规则生成，不影响镜序工作。

## 5. 本机语言模型连接

App 的“镜序助理 → 模型连接”允许配置 OpenAI-compatible 接口：

```text
base_url
model
api_key
```

模型连接属于设备本地状态：

```text
~/Library/Application Support/MirrorOrder/model-connections.json
~/Library/Application Support/MirrorOrder/model-secrets.json
```

`model-secrets.json` 尽可能以 `0600` 权限保存。

API Key 不得写入：

- workspace
- project.toml
- `assistant.json`
- `audit.json`
- `review.json`
- `editorial.json`
- `auto_decisions.json`
- Team Web payload

Team Web 不显示 provider、模型名、API Key 或运行时诊断。

## 6. 语言模型规划

语言模型不是自由 Agent。它只能输出结构化计划：

```json
{
  "briefing": "一句制作简报",
  "actions": [
    {
      "tool": "run_priority_audit",
      "arguments": {
        "group_ids": ["G_001"]
      }
    }
  ],
  "questions": [
    {
      "group_id": "G_001",
      "text": "需要用户判断的问题"
    }
  ]
}
```

Host 会重新验证工具名与参数；模型写出的任意未注册工具都不会执行。

自动模型规划默认关闭。只有：

- 用户在 App 点击“让助理规划”；或
- Host 明确设置 `MIRRORORDER_ASSISTANT_AUTO_PLAN=1`

才允许调用语言模型做规划。

这与自动 priority audit 不同：后者是确定性调度，只在本地视觉已经启用、存在高价值未审计异常时运行。

## 7. 主动问题队列

助理优先级不是“AI confidence 排行”，而是生产风险排序：

```text
100  人工归集 vs 当前算法冲突
 96  AI Audit 不同意算法
 95  当前 Host 缺媒体
 90  unresolved
 86  needs_review
 84  no_candidate
 82  top candidates 分差过小
 66  技术质量 / continuity 风险
 38  角色候选待人工确认
```

用户主要看到自然语言和动作：

```text
看片
判断归集
确认人物
```

而不是模型名称、embedding、prompt、token、runtime 或算法调试字段。

## 8. 人物与多机位

角色推断只能作为候选。

可靠链路：

```text
speaker cluster
+ ASR 对白
+ 已可靠归集的剧本范围
+ 剧本 speaker
→ role_suggestion
```

多机位必须保持：

```text
speaker != visible_actor
```

例如 B 机画面拍王强，但现场正在说话的是李雪，这不是冲突。没有可靠视听绑定时，助理不得因为台词属于李雪就把 B 机画面人物标成李雪。

人工确认过的 face / speaker identity 不应重复计算或被自动覆盖。

## 9. Agent API

外部 Codex / Agent 与镜序助理不是同一权限主体，但共享同一套安全边界。

现有 Agent API：

```text
/api/agent/v1/projects/{project_id}/...
```

Gateway 对外使用 workspace-scoped 路由：

```text
/api/agent/v1/workspaces/{workspace_id}/projects/{project_id}/...
```

Bearer token scope：

```text
read
analyze
propose
```

本轮新增：

```text
GET  /api/agent/v1/projects/{project_id}/assistant
POST /api/agent/v1/projects/{project_id}/assistant/cycle
```

`assistant/cycle` 需要 `analyze` scope。即使通过 Agent API 触发，仍只能调用 Assistant 的 allowlisted tools；Agent API 本身仍无权直接写人工审核。

App 的镜序助理面板现在有明确的 **Agent API** 入口，用于查看接口和权限边界；普通 Team Web 不展示这一制作配置。

## 10. 算法学习

镜序助理可以调用 `collect_learning_cases` 更新 `learning_cases.jsonl`，但生产 matcher 永远不读取这个文件。

正确升级链：

```text
生产失败案例
→ human override / audit disagreement
→ learning_cases.jsonl
→ failure pattern clustering
→ candidate algorithm patch
→ offline replay / regression
→ 人工批准 promotion
→ 下一版 production algorithm
```

禁止：

```text
LLM 发现问题
→ 直接修改 production matcher
→ 自动部署
```

## 11. App / Web 边界

### App Production

可以：

- 查看镜序助理主动问题；
- 点击问题直接看片 / 归集 / 人物库；
- 查看视觉、语言和 Agent API 是否可用；
- 配置本机语言模型连接；
- 点击“让助理规划”；
- 与镜序助理进行当前项目范围内的自然语言问答。

### Team Web Review

只接收经过 Host 投影的安全 `assistant.v1`：

- summary
- items
- messages

不暴露：

- provider 配置
- API Key
- 模型路径
- Host runtime
- Agent token 管理
- 自动生产任务控制

## 12. 下一阶段

Assistant Orchestrator 已经提供真正的控制平面。下一阶段优先增加的不是更多聊天能力，而是更丰富的**第一方安全工具**：

1. `extract_visual_evidence(group_ids)`
2. `index_unknown_identities(group_ids)`，跳过已确认 identity
3. `build_coverage_graph(scene_id)`
4. `find_continuity_risks(scene_id)`
5. `evaluate_algorithm_candidate(version)`，仅离线 replay
6. Rough Cut Planner，以 Coverage Graph + Editorial Decision 为输入

每增加一个工具，都必须单独定义写入边界、算力上限和回归测试。
