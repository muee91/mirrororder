# MirrorOrder AI Audit & Algorithm Learning Loop

`audit.v1` 的目标不是用一个大模型替换 MirrorOrder 的确定性算法，而是建立一个可复现的闭环：

```text
确定性分析
  ↓
证据包
  ↓
AI Shadow Judge / 素材审计
  ↓
问题分类 + 反例 + Shot Intelligence
  ↓
人工修正 / Editorial
  ↓
learning_cases.jsonl
  ↓
离线 Replay / Eval
  ↓
候选算法版本
  ↓
通过回归门槛后才升级 Production
```

AI 可以指出算法缺陷、形成实验样本、辅助提出新规则或新特征，但**生产算法不允许在运行中自行改写自己**。

## 1. 权威边界

MirrorOrder 继续区分：

```text
auto_decisions.json   自动剧本归集
review.json           人工归集 / legacy 人工审核
editorial.json        Individual Opinion / Editorial Decision
audit.json            AI审计与素材智力（证据）
```

`audit.json` 不是新的审核权威。

红线：

- AI Audit 不写 `review.json`；
- AI Audit 不写 `editorial.json`；
- AI Audit 不写 `auto_decisions.json`；
- Audit 不能产生 Best / Keep / Reject；
- Audit disagreement 只表示“需要检查”，不能覆盖人工或自动结果；
- Individual Opinion 仍不能投票产生 Final Editorial Decision；
- Production matching 不读取 `learning_cases.jsonl`。

## 2. Audit 是“评委”，不是第二套 Matcher

AI 的主要问题不是再次回答：

> 这个 Take 最像哪句剧本？

而是针对当前算法结论做红队检查：

```text
当前算法认为：S_23_014

Audit 检查：
- 对白是否真的支持？
- 是否出现跨集重复台词？
- 前后 Take 顺序是否支持？
- 是否可能为 pickup？
- 多机位画面是否与说话人不一致？
- 是否只是 reaction / insert / establishing？
- 技术质量是否有问题？
- 当前证据是否根本不足？
```

输出只有：

```text
agree
disagree
insufficient_evidence
```

而不是新的“官方剧本位置”。

## 3. Evidence Pack

每个被审计 Take 构造一个有界证据包：

```text
Take 结构
- group_id
- A/B/C / 重复机位
- timeline / source range
- duration / split reason

当前算法
- status
- mapping source
- script_segment_ids
- confidence
- reason

人工事实
- placement / assignment

候选
- top candidate ids
- total/dialogue/sequence/margin
- transcript
- 对应剧本片段和角色

人物证据
- 已有 face/speaker identity cluster
- 人工确认角色（如有）

视觉语义
- 已缓存 semantic（如有）

画面
- 每个实际 clip_id 最多一个代表帧
- 总量最多 6 帧
```

Evidence Pack 不把本机 `/Volumes/...` 路径写入 `audit.json` 或 Web read model。

## 4. 算力预算

Audit 默认不是新项目启动条件，也不自动全量运行。

默认入口：

```text
mode = priority
max_groups = 60
```

优先级高的 Take 包括：

1. 人工归集与自动归集冲突；
2. missing media；
3. unresolved；
4. needs_review；
5. top candidates 过近；
6. 无对白证据；
7. 其它需要为粗剪补结构信息的 Take。

每个 Take 的证据包有 `evidence_fingerprint`。

只要以下信息没有变化：

```text
当前分析
当前算法状态
人工归集
候选
人物证据
已有 semantic
```

再次 Audit 会直接复用旧结果，不重复 VLM 推理。

因此 Audit 是：

> 稀疏 + 事件驱动 + 可缓存

而不是连续扫描视频。

## 5. Failure Taxonomy

`audit.v1` 先固定一套可统计的问题语言：

```text
mapping_conflict
needs_review
unresolved
candidate_competition
no_candidate
no_dialogue_evidence
missing_media
multicam_speaker_visual_mismatch
possible_pickup
continuity_risk
technical_quality
algorithm_disagreement
other
```

之后算法升级不应只看“准确率”，还要看失败类型是否减少。

例如：

```text
short-dialogue collision ↓
pickup ordering error ↓
false confident assignment ↓
unresolved ↓
```

## 6. 演员 / 角色识别

### 6.1 已确认身份不重复计算

人物/声纹 identity cluster 仍属于当前设备本地感知数据。

当一个 Take 中某类身份观察已经全部绑定到人工确认 identity 时，普通重跑和指定 Take 重跑都直接复用。

模型、阈值或 profile 以后升级，也不能因为版本变化就自动擦掉这些人工确认结果重新计算。

只有开发者明确 `force_reindex=True` 才允许重建。

### 6.2 声纹可以从剧本提出角色候选

当已经存在 speaker cluster，并且：

- Take 的剧本归集来自人工，或自动归集足够可靠；
- speaker observation 有实际 ASR 文本；
- cluster 尚未被人工命名；
- 当前剧本段有明确 `speaker`；
- speaker 文本与该角色台词有足够相似度；
- 多角色场景中第一名与第二名有足够 margin；

Audit 可以产生：

```json
{
  "identity_id": "speaker_xxx",
  "kind": "speaker",
  "role_name": "演员A",
  "source": "script_dialogue_alignment",
  "requires_confirmation": true
}
```

这只是“角色候选”。

在 App 中人工确认后，现有 Identity Library 才把它变成人工 role_name。

### 6.3 画面人物不能因为台词被自动命名

多机位场景经常出现：

```text
A机：说台词的人
B机：听台词的反应镜头
C机：双人或道具
```

因此不能执行：

```text
检测到台词是“演员A”
+
B机画面检测到一张脸
=
这张脸就是演员A   // 禁止
```

当前版本**不会用剧本台词自动给 face cluster 写角色名**。

Face identity 继续依赖：

- 人工命名；或
- 未来可靠的 active-speaker / lip-motion / audio-visual binding。

没有可靠视听绑定时保持人工确认，这是正确退化路径。

## 7. Shot Intelligence 按机位保存

景别不是 Take 全局属性，而是 `clip_id` 属性。

一个 Take 可以同时存在：

```text
A → 全景
B → 近景
C → 特写
```

`audit.v1` 当前景别枚举：

```text
wide              全景
full              全身
medium            中景
medium_closeup    中近景
closeup           近景
extreme_closeup   特写
insert            细节
unknown           未知
```

同时可以记录：

```text
coverage_role
visible_people
technical_issues
```

镜序素材卡片直接显示景别，小标签不会盖过文件名和 A/B/C 机位信息。

## 8. Rough Cut Intelligence

Audit 同时积累后续粗剪需要的最小结构：

```text
technical_usability
  good / usable_with_caution / poor / unknown

take_completeness
  complete / partial / pickup / false_start / unknown

coverage_role
  master / dialogue / reaction / insert / establishing / transition / unknown

continuity_risk
  low / medium / high / unknown
```

后续 Rough Cut Planner 应消费这些已经审计过的结构，不重新从 1502 个文件零开始推理。

长期目标：

```text
Scene
  ├ Master
  ├ Dialogue CU / MCU
  ├ Reaction
  ├ Insert
  ├ Establishing
  └ Continuity warnings
```

形成 Coverage Graph 后再生成 assembly edit。

## 9. Algorithm Learning Dataset

每次 Audit 结束会生成：

```text
output/learning_cases.jsonl
contract = learning.v1
```

收集条件包括：

- human override；
- human vs auto mapping conflict；
- Audit disagreement；
- needs_review；
- unresolved。

其中不保存媒体绝对路径，只保存可 replay 的算法证据和期望。

重点样本不是“容易正确”的 Take，而是：

```text
算法很自信但人工改错的案例
长期 unresolved
候选第一第二名难分的案例
AI Judge 找到明确反例的案例
```

## 10. Algorithm Self-Iteration

“算法自我迭代”必须解释为受控 R&D loop，而不是生产代码自改：

```text
1. Production algorithm N
2. 收集 learning.v1 hard cases
3. AI 聚类失败模式
4. AI / Codex 提出 feature / rule / matcher patch
5. 创建 Candidate algorithm N+1
6. 对 frozen eval set 回放
7. 比较 N vs N+1
8. 检查安全红线
9. 人工确认 promotion
10. 才成为新的 Production algorithm
```

推荐核心指标：

```text
mapping exact accuracy
false confident assignment rate
human override rate
needs_review rate
unresolved rate
regression count on frozen gold set
auto reject count = 0
```

其中最危险的不是 unresolved，而是：

> false confident assignment

因此算法升级不能只追求覆盖率。

## 11. Web / App 产品边界

普通 Web：

- 消费脱敏后的 `review.v1`；
- 可以看到每个机位的景别；
- 可以看到已确认角色 / 角色候选；
- 可以看到与看片有关的素材问题；
- 不展示模型名称、Provider、Host 文件路径；
- 不能启动 Audit。

原生 App Production：

- 可以读取完整 `audit.json`；
- 可以启动优先级 Audit；
- 可以进入人物库确认角色；
- 可以看到算法 feedback / 素材问题；
- 后续承接 Eval / Replay / Algorithm Promotion。

这样保持：

```text
App = Production / Diagnosis / Learning
Web = Review / Collaboration / Consumption
```

## 12. 下一阶段

`audit.v1` 稳定后，下一阶段不是立刻让 AI 改 matcher，而是实现：

1. Frozen Eval Set；
2. Replay Runner；
3. baseline vs candidate algorithm comparison；
4. false-confident regression gate；
5. Failure Taxonomy dashboard；
6. 基于 Shot Intelligence 的 Coverage Graph。

只有这些基础设施存在后，算法“自我迭代”才是可测、可回滚、可持续的工程能力，而不是模型随机调参。
