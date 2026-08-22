# 镜序自动整理与 AI Rescue

目标：**默认自动完成，人工只处理异常。**

Codex、第三方模型和本地模型都不是镜序核心运行依赖。素材同步、ASR、剧本候选、顺序对齐和高置信度确认均由 MirrorOrder Host 的确定性流水线执行；模型只处理本地算法已经判定为歧义的少量 Take。

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

已有 FCPXML 项目会跳过 `multicam_sync`，直接进入分析与自动确认。

## 2. 自动结果与人工结果分离

自动状态写：

```text
output/auto_decisions.json
```

人工状态仍只写：

```text
output/review.json
```

规则：

- `review.json` 永远高于 `auto_decisions.json`。
- 自动流程不得写 `review.json`。
- 自动流程不得自动 Reject。
- 人工一旦修改某个 Take / placement / assignment，后续自动解析将该组标记为 `human_override`。
- 自动确认默认语义是 `keep` / “剧本归属已确认”，不是创意意义上的“最佳镜头”。

## 3. 自动状态

```text
auto_confirmed  本地确定性证据充分
ai_confirmed    模型二审 + 本地复核通过
human_override  已有人工权威结果
needs_review    有候选但仍冲突
unresolved      无可靠对白/候选/证据不足
```

工作台把前三类视为“已完成”，默认人工只处理后两类。

## 4. 高置信度自动确认

当前自动确认至少要求：

- candidate confidence = `exact_dialogue`
- `total_score >= matching.high_confidence`
- `dialogue_score >= 0.80`
- `margin >= matching.minimum_margin`
- 有明确 `script_segment_ids`

通过后写入 `auto_decisions.json`，不会触碰人工审核。

## 5. 大模型何时介入

模型不是主匹配器。只有本地候选没有达到自动确认门槛时才考虑 AI Rescue。

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

## 6. 第三方 / 本地模型

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
```

所以镜序在完全离线、无 API Key、无 Codex 时仍能完成确定性主流程。

API Key 不得写入 workspace / project.toml / review.json。

## 7. multicam-audio-sync 的集成方式

MirrorOrder Host 直接调用同步脚本，不通过 Codex。

运行时按以下顺序寻找引擎：

1. `MIRRORORDER_MULTICAM_SYNC_ROOT`
2. App runtime 内的 `multicam-audio-sync`
3. repo `vendor/multicam-audio-sync`
4. `~/.agents/skills/multicam-audio-sync`

`macos-app/build_app.sh` 会优先把 repo vendor 或当前开发机安装的 skill 复制进 `镜序.app/Contents/Resources/runtime/multicam-audio-sync`。因此构建后的 App 运行同步时不需要 Codex。

同步产物：

```text
output/sync/synchronized.fcpxml
output/sync/sync_report.json
output/.multicam-sync/...
```

媒体目录项目同步成功后，项目配置会切换到生成的 FCPXML，让后续分析继续使用现有、已验证的 FCPXML 语义读取链，而不是另造一套多机位模型。

原始媒体不会被修改；已有用户 FCPXML 项目也不会被覆盖。

## 8. Host 任务

```text
prepare_project      完整自动流水线
multicam_sync        只做多机位音频同步 + XML
auto_resolve         只重跑自动确认 / AI Rescue
incremental_analyze  现有增量分析，完成后刷新自动决策
transcribe           定向 ASR，分析可用时刷新自动决策
evidence_extract     证据提取
```

CLI：

```bash
./script-organizer prepare workspace.toml <project_id>
./script-organizer multicam-sync workspace.toml <project_id>
./script-organizer auto-resolve workspace.toml <project_id>
```

## 9. 人工界面原则

工作台顶部显示：

```text
自动 N   AI N   人工 N   待处理 N
```

“只看未核对”应把 `auto_confirmed` / `ai_confirmed` 当作完成，只留下真正异常。

人工主要处理：

- 模型与本地证据冲突；
- top candidates 无法拉开；
- 无对白且没有可靠上下文；
- 跨集/非单调 pickup 导致顺序复核失败；
- 同步/媒体缺失异常；
- 需要创意判断的 Best / Reject。

## 10. 不允许的回归

- 不得把所有 Take 都发给大模型。
- 不得让模型搜索整本剧本后自由返回任意位置。
- 不得因为模型高置信度就绕过本地复核。
- 不得让自动流程写 `review.json`。
- 不得自动 Reject。
- 不得用 LLM 替代音频同步、ASR 时间戳、FCPXML 时间关系或 `media_id`。
- 不得恢复“每个 Take 默认都需要人工点一下”的产品逻辑。
