# MirrorOrder Production / Review Boundary

镜序把复杂度留在制作端，把清晰、可信、可直接判断的内容交给团队审阅。

这份文档是 `docs/ux-principles.md` 的工程落地补充。发生冲突时，以更严格的数据权威与人工审核规则为准。

## 1. 产品边界

### App — Production

App 是项目制作与内容治理端，负责：

- 项目创建、输入预检、素材目录与当前 Mac 的媒体绑定；
- 多机位同步、ASR、剧本匹配、自动归集与异常复核；
- 素材、剧本、Take 的细粒度检查；
- 人物、声纹和内容证据等可选增强；
- 生产任务、运行时、日志和诊断；
- Final Cut Pro / Premiere / Resolve 等本机桥接和交付输出；
- 把制作结果整理成适合团队消费的审阅数据。

项目仍然是 App 的一级对象。进入项目后，制作导航属于该项目，不重新变成全局“工作台”导航。

### Web — Review

Web 是团队审阅与决策端，负责：

- 选择项目与集数；
- 按剧本查看候选 Take；
- 播放、切换机位；
- Best / Keep / Reject 与人工归集；
- 搜索、人物上下文、分析建议；
- 审核人身份、团队意见与协作。

普通 Web 不承担：

- 项目创建与本机素材目录管理；
- FFmpeg / 模型 / runtime / gateway / 端口设置；
- 生产任务启动、重跑与诊断；
- 本机文件拖入外部剪辑软件；
- 身份聚类拆分、底层匹配参数或算法调参。

Web 的简洁不是减少能力，而是由 App / Host 先完成制作治理后再呈现。

## 2. 当前 Phase 1：App-only Production Layer

当前 macOS 项目工作区仍复用成熟的 Web 审阅渲染和 AppKit 原生拖拽桥。为避免一次性重写已验证的看片链，第一阶段在同一页面之上增加 App-only Production Layer：

```text
镜序 App
  Native toolbar
      ↓
  WKWebView + mirrorOrder AppKit bridge
      ↓
  Production Layer
    审阅 / 概览 / 待处理 / 素材 / 剧本 / Take / 人物
      ↓
  已验证的 Review surface
```

普通 LAN 浏览器没有 `window.webkit.messageHandlers.mirrorOrder`，`production_mode.js` 会立即退出，因此不会注入制作导航或制作详情。

Production Layer 当前只读取已经加载的项目事实与审核状态，不新增独立写入通道。复杂修改仍继续使用已有、受约束的人工审核接口或原生制作操作。

### 制作概览

汇总：

- 当前 Mac 可确认的素材覆盖；
- Take 总量与存在人工治理记录的 Take；
- 可匹配剧本段与集数；
- 明确需要制作人员处理的例外。

### 待处理

只集中展示当前已有数据能够可靠支持的制作异常：

- 没有可靠剧本候选的 Take；
- `possible_dialogue` 或 top candidates 分差过小的归集歧义；
- 当前 Mac 明确报告为缺失的媒体；
- `matches.script_gaps` 中的剧本空档。

这里暂不把客户端推断冒充 `auto_confirmed / ai_confirmed / needs_review` 等正式自动状态。正式状态应由 Host 的权威自动决策数据提供。

### 素材

以 `clip_id` / `media_id` 和当前设备解析结果为基础检查素材。当前设备绝对路径仍是 Device Local，不能回写成共享项目事实。

### 剧本

按集查看可匹配段落、已有候选覆盖和明确 script gaps。点击后回到审阅区定位，不在 Production Layer 中复制一套剧本编辑器。

### Take

按当前已有证据区分：

- 人工：已有人工归集或审核记录；
- 高可信：首选候选为 `exact_dialogue`；
- 歧义：`possible_dialogue` 或候选分差不足；
- 待归集：没有非 context-only 候选；
- 上下文：主要依赖邻近拍摄上下文。

这些是制作端的可视化分类，不改变 `review.json` 和自动决策权威。

### 人物

人物与声纹仍使用现有身份库与增强流程。Production Layer 提供项目级入口；普通 Web 只消费已整理的人物上下文和必要的查看入口。

## 3. 数据权威不变

必须继续遵守：

```text
人工 review.json
    > 自动 auto_decisions.json
    > 自动候选 / 分析建议
```

- 自动流程不得写 `review.json`；
- 不得自动 Reject；
- 人工 placement / assignment / review 不得被自动结果覆盖；
- Production Layer 不建立第二套人工结论存储；
- 原始 FCPXML、原始媒体不可由审阅或展示层修改。

## 4. 多设备边界不变

共享的是项目事实与人工决定，不是某台电脑的绝对媒体路径。

```text
共享：script / material_index / matches / review / media_id
设备本地：media-bindings.json / /Volumes/... / Finder 路径 / native drag path
```

App 可以展示当前 Mac 的本机覆盖和路径诊断，但 Web 不需要、也不应该知道客户端机器的本地素材路径。

## 5. Phase 2：Host Review Read Model

下一阶段应把当前 Web 对多个底层文件的理解进一步收口到 Host，形成面向审阅的只读投影。例如：

```text
Canonical Production Data
  material_index
  script
  matches
  auto_decisions
  review
  identity / evidence
        ↓
MirrorOrder Host
        ↓
Review Read Model
        ↓
Web Review
```

建议的契约方向：

```text
review.v1
  project
  episodes[]
    scenes[]
      script_blocks[]
      take_groups[]
        takes[]
          angles[]
          transcript
          people
          evidence
          automatic_state
          editorial_state
          issues[]
          playback
```

要求：

1. Web 不再自行解释底层算法文件的组合语义；
2. Host 明确区分自动分析、Individual Opinion 与 Editorial Decision；
3. Review Read Model 是投影，不成为新的写入权威；
4. 制作端可以看到更完整的 evidence / diagnostics，Web 只拿审阅真正需要的字段；
5. 版本化契约，避免前端依赖内部文件结构。

Phase 2 在 Host API 完成并有契约测试之前，不应删除现有稳定的 `/script`、`/groups`、`/matches` 审阅读取路径。

## 6. UI 约束

Production Layer 仍遵守镜序的专业工具视觉语言：

- 中性 graphite / macOS 后期工具式表面；
- 高信息密度、低视觉噪音；
- Pane、Divider、List 优先，不堆 Card / Pill / Badge；
- 蓝色只表示选择/进行中，绿色完成，黄色需要人工注意，红色失败/危险；
- 模型名、embedding、runtime 等实现术语只进高级设置/诊断；
- 一个区域只保留一个真正突出的主要动作。

## 7. 回归红线

- 普通浏览器不得因为 Production Layer 增加项目创建、素材绑定、runtime 或生产任务入口；
- 不得删除 AppKit 原生文件拖拽桥；
- 不得用 HTML5 `dataTransfer` 冒充外部文件拖拽；
- 不得让客户端制作分类写回自动或人工权威状态；
- 不得把 workspace 恢复为日常一级导航；
- 不得因为 App 功能更细，就把 Web 重新做成制作控制台。
