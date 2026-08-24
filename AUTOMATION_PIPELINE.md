# 镜序自动整理、AI Rescue 与 Shadow Audit

目标：**默认自动完成，人工只处理异常。**

Codex、第三方模型和本地模型都不是镜序核心运行依赖。素材同步、ASR、剧本候选、顺序对齐和高置信度确认均由 MirrorOrder Host 的确定性流水线执行。

模型现在有两条严格分开的链：

1. **AI Rescue（生产决策链）**：只处理本地算法已经判定为歧义的少量 Take，只能在已有候选中选择，并必须通过本地复核；
2. **Shadow Audit（只读审计链）**：可以优先抽查冲突、人工 override、needs_review / unresolved 和其它高信息量 Take，用于找算法反例、列素材问题和生成粗剪结构，但不得改变任何审核或自动归集结果。

## 1. 新项目默认流水线

媒体目录项目创建后自动提交 `prepare_project`：

```text
素材目录 + 剧本
↓
multicam_sync
  ffprobe / ffmpeg
  FFT 音频互相关
  TC 先验
  鲁棒联合拟合
↓
synchronized.fcpxml
↓
analyze
  Take / A-B-C
  faster-whisper ASR
  多行剧本窗口召回
  range-aware sequence alignment
↓
auto_resolve
  高置信度规则确认
  低置信度可选模型二审
  确定性复核
↓
工作台
  自动完成 / AI确认 / 人工覆盖 / 待处理
```

`prepare_project` **不会自动运行全量 Shadow Audit**。素材审计是显式、可缓存、受 Host 视觉资源调度的 Production 任务，避免新项目因为增加 AI 能力而突然变成全量视频推理。

已有 FCPXML 项目会跳过 `multicam_sync`，直接进入分析与自动确认。

创建项目之前，Host 会执行不写盘预检：

- 剧本能否解析出集数和可用段落；
- FCPXML 主项目 sequence 能否解析出逻辑素材，包含 `media-rep`、`ref-clip` 和 `mc-clip` 角度；
- 输入文件权限、项目目录写权限；
- 媒体目录项目的 FFmpeg、FFprobe、Python 科学计算依赖和仓库内第一方引擎是否就绪。

缺失源媒体只产生警告并保留逻辑片段，后续由当前设备的 `media-bindings.json` 解决；预检不会复制原始媒体、修改原始 FCPXML 或写入审核。

## 2. 自动结果、人工结果与审计结果分离

自动状态写：

```text
output/auto_decisions.json
```

人工状态仍只写：

```text
output/review.json
```

协作意见与最终编辑决定写：

```text
output/editorial.json
```

AI Shadow Audit 写：

```text
output/audit.json
```

算法研发 hard cases 写：

```text
output/learning_cases.jsonl
```

规则：

- `review.json` 永远高于 `auto_decisions.json`。
- 自动流程不得写 `review.json`。
- 自动流程不得自动 Reject。
- 人工一旦修改某个 Take / placement / assignment，后续自动解析将该组标记为 `human_override`。
- 自动确认默认语义是 `keep` / “剧本归属已确认”，不是创意意义上的“最佳镜头”。
- `audit.json` 只是可重建证据，不是新的审核权威。
- Shadow Audit 不得写 `review.json`、`editorial.json` 或 `auto_decisions.json`。
- Production matcher 不读取 `learning_cases.jsonl`；它只用于离线 replay / eval / 算法研发。

## 3. 自动状态

```text
auto_confirmed  本地确定性证据充分
ai_confirmed    模型二审 + 本地复核通过
human_override  已有人工权威结果
needs_review    有候选但仍冲突
unresolved      无可靠对白/候选/证据不足
```

工作台把前三类视为“已完成”，默认人工只处理后两类。

注意：Shadow Audit 的 `agree / disagree / insufficient_evidence` **不是新的自动状态**，不会把一个 Take 从 `needs_review` 直接升级成 `ai_confirmed`。

## 4. 高置信度自动确认

当前自动确认至少要求：

- candidate confidence = `exact_dialogue`
- `total_score >= matching.high_confidence`
- `dialogue_score >= 0.80`
- `margin >= matching.minimum_margin`
- 有明确 `script_segment_ids`

通过后写入 `auto_decisions.json`，不会触碰人工审核。

## 5. AI Rescue 何时介入

AI Rescue 不是主匹配器。只有本地候选没有达到自动确认门槛时才考虑模型二审。

Host 只发送：

- 当前 Take ASR
- 本地 top-N candidate
- candidate 对应的小段剧本文本
- 本地分数
- 前后已确认剧本位置

模型**只能返回已有 `candidate_id`**，不能自己发明剧本范围。

模型返回后还必须通过：

1. 模型置信度门槛；
2. 本地文本/对白最低支持；
3. 前后剧本顺序一致性；
4. 当前 candidate 必须属于本地候选集合。

任一失败 → `needs_review`，不自动写人工结果。

## 6. Shadow Audit 如何介入

Shadow Audit 的目标不是再次充当 matcher，而是尝试证明当前算法判断有问题，并积累后续粗剪需要的结构化素材智力。

默认 Production 入口：

```text
mode = priority
max_groups = 60
```

优先审计：

- 人工归集 / override 与自动候选存在差异的 Take；
- `needs_review`；
- `unresolved`；
- top candidates 过近；
- 无可靠对白；
- 当前 Host 缺媒体；
- 需要补景别、coverage、连续性或技术质量信息的高价值 Take。

每个 Take 生成 evidence fingerprint。输入证据没有变化时直接复用 `audit.json`，不重复调用 VLM。

审计输出包括：

```text
verdict
  agree / disagree / insufficient_evidence

issues
  failure taxonomy + severity + detail

algorithm_feedback
  failure_class
  suspected_missing_feature
  counterexample

shot_intelligence · per clip_id
  shot_type
  coverage_role
  visible_people
  technical_issues

rough_cut
  technical_usability
  take_completeness
  coverage_role
  continuity_risk
```

多机位景别按 `clip_id` 保存。例如同一个 Take 可以是：

```text
A → 全景
B → 近景
C → 特写
```

不能把某一机位的景别复制给整个 Take。

完整边界见 `docs/ai-audit-learning-loop.md`。

## 7. 演员 / 角色推断边界

声纹可以利用已确认的剧本归集提出角色候选：

```text
speaker cluster
+
该 cluster 的 ASR 文本
+
当前已归集剧本段的 speaker / dialogue
↓
角色候选（requires_confirmation=true）
```

已经人工确认的身份不得因为再次索引、指定 Take 重跑或模型 profile 更新而重复计算覆盖；只有明确的开发者强制重建才允许重新索引。

多机位画面不能因为台词角色而自动给 face cluster 命名。B/C 机可能拍的是听者、反应镜头或双人镜头，所以：

- speaker → 剧本角色：允许提出候选；
- face → 剧本角色：默认人工确认；
- 未来只有在可靠 active-speaker / lip-motion / audio-visual binding 存在时，才考虑自动建立 face ↔ speaker 关系。

## 8. 第三方 / 本地模型

当前 Provider 使用 OpenAI-compatible `chat/completions` 接口。通过 Host 进程环境变量配置：

```bash
export MIRRORORDER_MODEL_PROVIDER=openai-compatible
export MIRRORORDER_MODEL_BASE_URL='https://provider.example/v1'
export MIRRORORDER_MODEL_API_KEY='...'
export MIRRORORDER_MODEL_NAME='model-name'
export MIRRORORDER_MODEL_MIN_CONFIDENCE='0.84'
```

也可以指向本机 OpenAI-compatible server：

```bash
export MIRRORORDER_MODEL_BASE_URL='http://127.0.0.1:1234/v1'
```

未配置 Provider 时：

```text
高置信度 → 自动确认
低置信度 → 直接进入 needs_review / unresolved
Shadow Audit → 保留确定性问题分类和已有缓存，不影响主流程
```

所以镜序在完全离线、无 API Key、无 Codex 时仍能完成确定性主流程。

API Key 不得写入 workspace / project.toml / review.json / audit.json。

## 9. multicam-audio-sync 的第一方集成方式

MirrorOrder Host 通过项目内 `multicam_sync_engine` API 原地调度仓库内第一方同步实现，不通过 Codex，也不在运行时依赖外部 skill。每个项目只生成自己的 `.multicam-sync/config.json`、音频缓存和位置表，不复制算法源代码。

运行时使用以下来源：

1. App runtime 内的 `multicam-audio-sync`
2. 仓库 `vendor/multicam-audio-sync`

开发调试可同时设置 `MIRRORORDER_MULTICAM_SYNC_ROOT` 与 `MIRRORORDER_ALLOW_MULTICAM_SYNC_OVERRIDE=1` 覆盖第一方目录；普通发布构建始终使用仓库 vendor，缺少它会直接失败。`macos-app/build_app.sh` 将脚本、参考文档、FCPXML 校验器和 `capcut_draft_schema.json` 一并复制到 `镜序.app/Contents/Resources/runtime/multicam-audio-sync`，因此另一台 Mac 运行同步时不需要 Codex、Python 外部技能目录或本项目之外的同步包。

第一方引擎的职责边界：

- `sync.py` 负责 TC 先验、音频互相关和鲁棒拟合；
- `build_fcpxml.py` 输出 FCPXML 1.8 原生多机位时间线；
- `build_capcut_fcpxml.py` 与 `build_capcut_draft_31.py` 是剪映适配器；
- `build_pr_xml.py` 输出 Premiere 可导入的 FCP7/xmeml v4；
- `validate_fcpxml.py` 在 Host 生成交付 FCPXML 后执行帧边界、素材路径、引用和结构校验；
- `validate_capcut_draft.py` 在生成剪映 3+1 草稿后执行结构不变量校验。

媒体目录同步前，Host 会检查 `ffmpeg`、`ffprobe` 和 `numpy`、`pandas`、`scipy`；所需 Python 依赖写在第一方引擎的 `vendor/multicam-audio-sync/requirements.txt`。剪映加密草稿编解码额外使用 `pycryptodome`，但不是普通 FCPXML/Premiere 同步的必需依赖。

同步产物：

```text
output/sync/synchronized.fcpxml
output/sync/sync_report.json
output/.multicam-sync/...
```

同步报告还会记录剪映 FCPXML、剪映原生 3+1 草稿、Premiere XML 的实际生成和校验结果；这些适配器失败不会伪装成主同步成功以外的状态。

媒体目录项目同步成功后，项目配置会切换到生成的 FCPXML，让后续分析继续使用现有、已验证的 FCPXML 语义读取链，而不是另造一套多机位模型。

原始媒体不会被修改；已有用户 FCPXML 项目也不会被覆盖。

## 10. Host 任务

```text
prepare_project      完整确定性主流水线 + AI Rescue；不自动全量 Audit
multicam_sync        只做多机位音频同步 + XML
auto_resolve         只重跑自动确认 / AI Rescue
incremental_analyze  现有增量分析，完成后刷新自动决策
transcribe           定向 ASR，分析可用时刷新自动决策
evidence_extract     定向证据提取
identity_index       App 显式人物 / 声纹索引
audit                App 显式 Shadow Audit；默认优先级 + 缓存
```

CLI 主流水线仍保持：

```bash
./script-organizer prepare workspace.toml <project_id>
./script-organizer multicam-sync workspace.toml <project_id>
./script-organizer auto-resolve workspace.toml <project_id>
```

Audit 当前由 App Production 提交 Host 任务，不作为 Agent 可提交任务，也不作为 Web 审阅操作。

## 11. 人工界面原则

工作台顶部继续显示生产状态：

```text
自动 N   AI N   人工 N   待处理 N
```

这里的 `AI` 指生产链的 `ai_confirmed`，**不是 Shadow Audit 数量**。

“只看未核对”应把 `auto_confirmed` / `ai_confirmed` 当作完成，只留下真正异常。

人工主要处理：

- 模型与本地证据冲突；
- top candidates 无法拉开；
- 无对白且没有可靠上下文；
- 跨集/非单调 pickup 导致顺序复核失败；
- 同步/媒体缺失异常；
- 需要创意判断的 Best / Reject；
- Audit disagreement 或素材质量提示中确实需要制作判断的项目。

素材卡可以直接显示景别和角色上下文，但文件名、机位和播放仍是主信息。不得把页面改造成模型诊断控制台。

## 12. 算法自我迭代

所谓“算法自我迭代”必须是受控研发闭环：

```text
Production algorithm N
↓
learning_cases.jsonl
↓
AI 聚类失败模式 / 提出 feature 或 rule 假设
↓
Candidate algorithm N+1
↓
Frozen Eval Set / Replay
↓
与 N 比较
↓
安全门槛 + 人工 promotion
↓
Production algorithm N+1
```

禁止：

```text
运行中的模型发现问题
↓
直接修改 matcher.py
↓
立即进入生产
```

后续 Eval 至少要跟踪：

- mapping accuracy；
- false confident assignment rate；
- human override rate；
- needs_review rate；
- unresolved rate；
- frozen gold regression count；
- auto Reject count = 0。

## 13. 不允许的回归

- 不得把所有 Take 都发给大模型。
- 不得让 AI Rescue 搜索整本剧本后自由返回任意位置。
- 不得因为 AI Rescue 模型高置信度就绕过本地复核。
- 不得让 Shadow Audit 直接升级为 `ai_confirmed`。
- 不得让 Shadow Audit 写 `review.json` / `editorial.json` / `auto_decisions.json`。
- 不得按 AI Judge 的 disagreement 自动 Reject 或改剧本归集。
- 不得把多机位某一画面的人脸因为台词角色而自动命名。
- 不得重复计算并覆盖人工已确认的演员 / 声纹身份。
- 不得把同一个 Take 的某个机位景别复制给其它机位。
- 不得让生产 matcher 读取 `learning_cases.jsonl` 形成隐式反馈环。
- 不得自动 Reject。
- 不得用 LLM 替代音频同步、ASR 时间戳、FCPXML 时间关系或 `media_id`。
- 不得恢复“每个 Take 默认都需要人工点一下”的产品逻辑。
