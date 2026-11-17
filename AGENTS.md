# 镜序工程接手约束

**唯一当前产品目标：[`docs/product/REBUILD_2026-11-17.md`](docs/product/REBUILD_2026-11-17.md)。** 本文只管开发边界，旧五步 Product Recovery 不是当前优先级。未完成的重制代码位于独立分支/Draft PR，不得称为 `main` 已发布。

## 接手先读

1. `docs/product/REBUILD_2026-11-17.md`：真实短剧用户场景和同步优先顺序。
2. `docs/engineering/STATUS.md`：当前有证据的能力与缺口。
3. `docs/engineering/BACKLOG.md`：唯一当前执行顺序。
4. `docs/engineering/INVARIANTS.md`：安全、authority、测试约束。
5. `docs/README.md`：按需查阅技术契约，不要通读历史开发记录。

## 产品顺序

```text
导入原始视频与同期 WAV → 多机位智能同步 → 核对/修正错位
→ 分发多轨同步母版和目标 NLE 多机位工程
→ 后台关联场记、剧本、演员、真实对白、镜头语义
→ 剪辑中随时按拍摄顺序或剧本顺序检索并定位本机素材
```

- 第一交付物是同步工程。缺剧本、缺模型、未生成场记不应阻塞同步交付。
- 同步母版 ≠ 创意组接；多轨 XML 可导入 ≠ 目标软件已形成原生可切机位片段。
- Resolve、Premiere、Final Cut Pro、国内剪映专业版（Windows/macOS）按真实软件版本分别验收。剪映加密草稿逆向不能是唯一交付路径。
- 同步交付后的后台模型只能生成证据和建议，不得静默修改已交付母版。
- 人工补入临时特写、OS、临场对白；剧本正文不能覆盖实际拍摄事实。

## 技术与权限

- React/TypeScript + Tauri/Rust + Rust Timeline Core + Python MirrorOrder Core。现有「素材/剧本/时间线/审阅」是代码责任域，**不是强制导航或必须依次完成的工作流**。
- 复用现有同步引擎、媒体身份、Timeline Core、FCPXML/Premiere adapters、FFmpeg 和模型 Provider；不重新开发一个 NLE 或第二套 authority。
- Slate 是现场拍摄事实；Review placement 是人工剧本归属；Final Editorial Decision 是最终剪辑判断；Rust Timeline 是正式组接状态。统一 `evidence → proposal → human confirmation → authority`。
- AI 不得自动 Reject；Slate NG、Review exclusion 和 Final Reject 不同。
- `clip_id` 是项目 occurrence；`media_id` 是跨电脑物理媒体身份。绝对路径只归本机 binding，不进入共享事实。
- GET/Inspector 不做重扫描、FFmpeg、模型下载或长推理。长任务必须走 durable task，提供真实阶段、最近活动、错误和安全取消；没有可信分母不显示假百分比。
- 禁止提交真实 `projects/*`、媒体、cache/output、任务日志、模型、密钥和绝对路径；只保留 `projects/.gitkeep` 和合成 `tests/fixtures/`。
- 不追加全局 CSS 覆盖层掩盖 UI 结构问题，不把四个领域重新揉成一个巨型工作台。

## 验证与文档

```bash
python3 scripts/check_python.py
python3 scripts/check_fast.py
python3 scripts/check_full.py
```

CI 和合成测试不代表已在真实素材/外部 NLE 完成听看验收。只记录实际 PASS / FAIL / NOT RUN，禁止弱化行为测试换取绿灯。

产品只写 `docs/product/REBUILD_2026-11-17.md`；事实写 `docs/engineering/STATUS.md`；任务写 `docs/engineering/BACKLOG.md`；不可变工程规则写 `docs/engineering/INVARIANTS.md`；技术领域有对应 contract。旧阶段报告、一次性 prompt 和 closeout 归 Git 历史。
