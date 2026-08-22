# 工程接手约束

## 写代码前

- 理解现有实现、调用链和状态流。
- 先读 `README.md`、`项目介绍.md`、`DESKTOP_BRIDGE.md`、`SYNC_MODEL.md`、`AUTOMATION_PIPELINE.md`。
- 检查运行服务、项目配置、当前输出、`auto_decisions.json` 和 `review.json`。
- 不确定时先给出证据和不确定点，禁止猜测式修改。

## 数据权威

- 当前自动判断只使用：
  - FCPXML
  - DOCX剧本
  - ASR缓存
  - `review.json`人工审核
- 禁止读取CSV、旧素材清单或旧HTML结果参与自动匹配。
- `projects/beef/legacy_overrides.json` 仅为历史归档，不得重新接入牛肉项目分析。
- 人工结果永远高于自动结果。
- 系统不得自动Reject素材。
- 自动确认写 `auto_decisions.json`，不得伪装成人工审核，也不得直接写 `review.json`。

## 自动整理与模型救援

- 默认产品目标是“自动完成，人工只处理异常”，不是让每个 Take 都人工点一次。
- `prepare_project` 是完整主机流水线：媒体目录同步 → 生成 FCPXML → ASR/剧本分析 → 自动确认/AI Rescue。
- 高置信度结果可自动确认剧本归属；自动确认语义默认是 `keep`，不是创意意义上的“最佳镜头”。
- 低置信度时才允许调用可选模型；不得把全部 Take 都发给大模型。
- 模型只能在本地算法给出的 candidate_id 中选择，禁止从整本剧本自由发明位置。
- 模型结果必须再次通过本地最低分数、候选合法性与前后剧本顺序校验；未通过则进入 `needs_review`。
- 无对白且没有可靠上下文的素材不得靠语言模型伪造动作归属；保留 `unresolved`，未来视觉模型需走单独证据链。
- 未配置模型 Provider 时主流程仍必须离线可用：高置信度自动确认，低置信度进入异常队列。
- Provider API Key 不得写入 workspace、project.toml、review.json 或可同步产物。
- 修改这条链前先读 `AUTOMATION_PIPELINE.md`。

## 多设备与本机素材

- 跨设备素材身份使用 `media_id`，绝对路径不是共享身份。
- `clip_id` 表示项目/FCPXML occurrence；`media_id` 表示物理媒体文件，二者不得混用。
- 有源文件可读时 `media_id` 必须由内容指纹产生；`MP_...` filename identity 只允许作为旧项目迁移 fallback。
- 每台设备自己的 `media_id -> /Volumes/...` 映射保存到设备 Application Support，不得写入共享 workspace。
- macOS 默认设备状态：`~/Library/Application Support/MirrorOrder/media-bindings.json`。
- 不得把本机卷名、Finder路径、本机素材根目录写入 `material_index.json`、`review.json` 或项目共享配置作为权威字段。
- HTTP媒体播放和原生拖拽必须优先解析当前设备绑定；找不到本机媒体时明确显示缺失，不允许偷偷回退到错误同名文件。
- 同内容媒体复制到不同磁盘、目录甚至改名后，正式 `media_id` 应保持一致。
- 改多设备逻辑前先读 `SYNC_MODEL.md`。

## 多机位与FCPXML

- 涉及多机位同步或NLE XML时，使用当前 `multicam-audio-sync` 引擎；它是 Host 可直接调用的确定性引擎，不得依赖 Codex 才能运行。
- `macos-app/build_app.sh` 要把 repo vendor、`MIRRORORDER_MULTICAM_SYNC_ROOT` 或开发机 `~/.agents/skills/multicam-audio-sync` 中的引擎打包进 App runtime。
- 不修改原始FCPXML，不重建或破坏已有同步关系。
- 媒体目录项目允许生成新的 `output/sync/synchronized.fcpxml`，但不得覆盖用户已有 FCPXML。
- `organized.fcpxml` 默认必须与输入文件字节完全一致。
- 长素材按有效片内范围复用，禁止复制原始媒体。
- A/B/C展示顺序不得打乱。
- XML时间线预览只能读取和关联，不得直接修改用户加载的XML DOM或覆盖原XML。
- FCPXML预览至少兼容1.8 `asset src`、1.9+ `media-rep src`、主spine隐式顺序和multicam/media资源引用。

## Desktop Bridge

- 当前macOS构建入口是 `macos-app/MirrorOrderDesktopApp.swift`；旧App源码只作历史参考。
- 外部文件拖拽必须继续由 AppKit `NSDraggingSession` / `NSDraggingItem` 完成。
- 禁止用HTML5 `dataTransfer` 假装网页能向FCP/Premiere/Resolve提供本机文件。
- 拖出的对象是当前设备解析出的真实源文件URL，语义与Finder拖文件一致；不得自动生成代理、临时切片或复制媒体。
- 时间线和素材页必须保持双向关联：时间线点击定位Take/机位，素材点击反向高亮时间线。
- XML块无法可靠关联当前项目素材时必须显示“未关联”，禁止强猜。
- 改Desktop Bridge前先读 `DESKTOP_BRIDGE.md` 并保留其真机验收标准。

## 匹配原则

- 不得实现成“每个视频ASR后只搜索最像的一句剧本”。
- 先建立逻辑Take，再在Take内合并多机位对白证据。
- A机不是默认最佳收音，按项目配置优先B/C/A。
- 多集连拍允许一个Take归属多个集数和连续剧本范围。
- 无对白素材只能根据邻近拍摄块提出可能集数。
- 修改匹配算法后必须使用增量缓存，只重算受影响组。

## 前端产品约束

- 这是剪辑工作台，不是算法展示页。
- 顶部32集按钮必须直接可点，其他集隐藏而不是折叠。
- 默认按剧本时间轴排序。
- 剧本、素材列表和播放器独立滚动。
- 文件名是机位卡片最重要的信息。
- A/B/C卡片单行排列，宽度不足时局部横向滚动，禁止换行。
- 待归集模式不显示空白剧本栏。
- 不向页面添加算法宣传、冗余说明或“牛皮癣”文字。
- 切集、协作刷新和审核后保持各区域滚动位置。
- 时间线是辅助看片层，不得抢占剧本→候选Take的主工作流。
- 工作台要能看出当前设备素材定位覆盖率；浏览器远程访问时不得把服务器路径误称为客户端本机路径。
- 工作台要直接显示自动 / AI / 人工 / 待处理数量；自动确认和 AI 确认不得继续出现在默认“未核对”队列。

## 审核与协作

- 所有审核动作使用原子API写入。
- 写入必须带昵称和时间。
- 多浏览器更新不能覆盖其他人的新修改。
- 修改、分析重跑和服务重启后人工审核不得丢失。
- 测试协作写入后必须恢复，不留下虚假审核结论。
- 多台电脑同时审核时 `review.json` 必须有单一写入权威；禁止依赖 Dropbox/iCloud 文件级同步让多台机器直接并发写同一 `review.json`。
- 推荐架构：中央项目状态/review authority + 每台设备本地 media resolver/native drag bridge。
- 自动决策与人工审核必须分文件保存；人工 action 生效后界面必须立即覆盖自动状态，即使 `auto_decisions.json` 尚未重算。

## 验证要求

每次提交至少运行：

```bash
python3 -m py_compile src/script_organizer/*.py
python3 -m pytest -q
```

涉及自动化流水线时还要验证：

- 高置信度 exact_dialogue 进入 `auto_confirmed`。
- 模糊候选在无模型时进入 `needs_review`，而不是假自动确认。
- 模型只能返回已有 candidate_id；模型低置信度或顺序冲突必须回退人工。
- 自动流程不会产生 `reject`，除非该状态来自 `human_override`。
- `auto_decisions.json` 更新不会改动 `review.json`。
- 新建媒体目录项目会自动提交 `prepare_project`。
- 同步成功后项目使用生成的 `synchronized.fcpxml` 继续分析，而不是退回未同步 media-directory 时间线。

涉及前端时还要验证：

- 1920×1080和1600×900无重叠。
- 32集按钮两行直接可点。
- 卡片不换行。
- 精确文件名搜索可定位并播放。
- 长素材跳到片内起点并在终点暂停。
- 剧本、素材和播放器滚动互不影响。
- 浏览器控制台无错误。
- 时间线当前项目模式能显示真实拍摄位置。
- 加载FCPXML后未关联块有明确状态。
- 时间线与素材卡片双向定位有效。
- 自动确认/AI确认不会出现在“只看未核对”结果中。
- “待处理”只聚合 needs_review / unresolved 与真正未人工处理异常。

涉及macOS App时还要真机验证：

- `zsh macos-app/build_app.sh` 可以完成编译和codesign。
- 构建日志显示打包 `multicam-audio-sync`，且构建后的 App 不依赖 Codex 才能运行同步。
- 从素材卡拖到Finder得到当前设备真实文件。
- 从素材卡拖到Final Cut Pro至少完成普通文件接收测试。
- 普通点击素材仍然只执行播放/选择，不被拖拽桥接误伤。
- 第二台Mac选择不同素材目录后，播放与拖拽使用第二台Mac路径。
- 扫描本机素材不得修改共享 `material_index.json` / `matches.json` / `review.json`。

涉及导出时还要验证：

- 输入与 `organized.fcpxml` SHA-256一致。
- 1502条媒体关系仍存在。
- 不丢失原有多机位同步。

## 结果汇报

- 说明影响范围。
- 提供验证方法和结果。
- 明确区分已验证、部分完成、仍不确定和阻塞。
- 说明数据质量风险，不能把覆盖率包装成准确率。
