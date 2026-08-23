---
name: multicam-audio-sync
description: 多机位（2-3 台相机/手机）音画同步并交付 NLE XML。当用户提到 多机位/三机位/双机位/音画同步/音视频对齐/对时间码/TC 不准/生成 FCPXML/Premiere 可用的 XML/AAF/竖屏短剧素材对齐 时使用——即使只丢一个素材文件夹和一句"帮我同步"。方法：FFT 音频互相关 + 相机 TC 先验 + 鲁棒联合拟合，输出 Final Cut Pro 可导入的 FCPXML 1.8（剪映硬门槛 ≥1.8，见 references/capcut-jianying-adapter.md）和 Adobe Premiere 可导入的 FCP7/xmeml v4 两个 XML。
---

# 多机位音频同步 + NLE XML 生成

把 N 台相机（同场景同时开拍）的素材按**音频内容**对齐到同一时间轴，并生成 Final Cut Pro / Premiere Pro 可直接导入的 XML。适用于：TC 有但不准、无 TC、竖屏/横屏、不同品牌混用（Sony/iPhone/GoPro 等）。

## 何时触发

用户给出素材目录 + 同步诉求（多机位/对时间线/出 XML/给剪辑用）。典型措辞：`三机位音画同步`、`帮我生成fcpxml`、`PR能用的xml`、`对一下时间码`。

## 输入

- 素材根目录（可多天，如 `8.13 拍摄/`、`2024-05-01/`），目录名含日期，每相机一个子目录（如 A1/B1/C1、CAM_A/cam-b）。
- 相机数、帧率、分辨率、音频参数**全部自动探测**（ffprobe），无需手改脚本；探测失败或特殊素材可在 `scripts/config.json` 的 `manual` 里覆盖。
- 支持任意帧率：整数（24/25/30/50/60p）精确到每帧 1000 tick；NTSC（23.976/29.97/59.94）保留原始分数（24000/1001 等），帧边界精确。
- 素材是否带 TC（有更好，非必需；不准也能用）。

## 配置（scripts/config.json）

所有脚本通过 `project_config.get_config()` 读取 `scripts/config.json`，无需改代码：

```json
{
  "BASE": "/abs/path/to/source_footage_root",
  "WORK": "/tmp/syncwork",
  "OUT_DIR": "/abs/path/to/delivery",
  "manual": {
    "fps": 50, "width": 1080, "height": 1920,
    "audio_rate": 48000, "audio_ch": 2,
    "project_name": "示例项目", "camera_name": "Sony ILME-FX3",
    "out_name": "示例项目_多机位_音频同步_final.fcpxml"
  }
}
```

`manual` 全部可选：不写就自动探测。`project_name`/`camera_name`/`out_name` 控制交付文件命名与 FCP 相机元数据。

## 核心模型（先理解再动手）

1. **相机 = 刚体**：每台相机的 TC 机内自由连续运行（跨卡斜率≈1.000，可靠），但相机之间的 TC 偏移不可信。所以：单机内用 TC 定相对位置，机间偏移用音频互相关测。
2. **机间偏移 ≈ 恒定**（斜率≈0）：同场景连续拍摄时 delta_B(t)≈常数。用全天大量音频互相关锚点做鲁棒拟合，而不是只信一两个片段。
3. **间隙处理**：时间轴保留真实停机间隙；"三机全停"时段可压缩（所有素材一起前移，相对同步不变），单机停机间隙不可删（会破坏同步）。

## 流水线（详见 references/pipeline.md）

```
python3 make_index.py          # 盘点：ffprobe 提取时长/尺寸/TC/创建时间 -> index/durations/tc.tsv
python3 extract_parallel.py    # ffmpeg 并行提取 16k mono f32 音频缓存
python3 sync.py <day>          # 互相关测偏移 + TC 先验候选配对 + 鲁棒拟合 -> positions_<day>.tsv
python3 compress_gaps.py <positions...>   # (可选)压缩三机全停 -> *_compressed.tsv
python3 build_fcpxml.py        # FCPXML 1.8（多日合并单 multicam；剪映要求 ≥1.8）
python3 build_capcut_fcpxml.py # 剪映专用 FCPXML 1.8（spine 直接放 asset-clip，无 multicam）
python3 build_capcut_draft_31.py # 剪映原生 3+1 多机位草稿（3普通轨+1多机位，已对齐，推荐）
python3 build_pr_xml.py        # Premiere xmeml v4
```

所有脚本读 `scripts/config.json`（BASE/WORK/OUT_DIR/manual），换项目只改这一个文件。

## 交付前必须全过的校验（见 references/validation.md）

- [ ] 官方 `FCPXMLv1_8.dtd` xmllint 校验 0 错误（DTD 从 Final Cut Pro 应用包提取，见 validation.md）
- [ ] `<fcpxml version="1.8">`（剪映硬门槛 ≥1.8，1.7 会被拒）
- [ ] 全部 offset/duration/start 是整帧倍数（50fps 下 1000 tick 倍数）——否则 FCP 报"不在编辑帧边界上"
- [ ] 1502（全部）素材 pathurl/src 指向磁盘真实文件
- [ ] 所有 ref/angleID 引用解析无缺失
- [ ] 交叉闭合校验（AB+BC≈AC，残差应 <10ms）
- [ ] 随机预留对的抽查（预测偏移 vs 实测，应 <50ms）

## 关键坑（务必先读 references/pitfalls.md）

1. `corr_offset` 符号：实测返回 pos_a − pos_b（与直觉相反），约束公式是 delta = tcX − tcY − off，先做确定性合成信号测试再全量跑。
2. TC 先验污染：混入其他天/残留片段（dur<5s）会毁掉候选窗口，先验只用时长≥5s 的片段。
3. FCPXML 结构（DTD 强制）：`library` 只能含 `event|smart-collection`；`media`(multicam) 必须在 `resources`；`project`/`mc-clip`/`asset-clip` 必须在 `event`。
4. 帧边界：所有时间值必须整帧吸附，否则 FCP 拒导。
5. Premiere xmeml：file id 必须全文档唯一（跨序列共享）；单日序列 duration 取实际末端帧（不能是 0）。
6. macOS 并行：`mp.set_start_method("fork", force=True)` 且放 `if __name__=="__main__":` 内，heredoc 主模块会 spawn 崩溃。

## 参考仓库研究（references/lessons-from-reference-repos.md）

已实测研究 AudioAlign / syncdrop / Zelqivo 三个仓库，结论：syncdrop 与我们算法最接近（包络互相关 + peak/median 置信度 + offset 符号与我们一致）；AudioAlign 提供窗口化互相关（诊断时钟漂移）和音频指纹（波形相关失败的后备）；Zelqivo 证明无 multicam 结构的 FCPXML 只能顺序播放。低置信度配对（conf<10）先试**包络互相关**（diff+abs+50ms 平滑）再下结论。

## 适配剪映（references/capcut-jianying-adapter.md）

剪映专业版（本机 11.3.0 = VideoFusion-macOS.app）**直接支持导入 fcpxml**（对话框过滤器 `*.fcpxml *.fcpxmld *.prproj`），但 **FCPXML 版本必须 ≥1.8**（反汇编实证：`libVECreator.dylib` 里 `VersionStringToCode` 编码后与 1.8 比较，1.7 弹"FCPXML版本过低"）；**且剪映只认 `asset-clip` 作为时间线片段，不认 mc-clip/multicam/gap**（反汇编实证 `transferStoryItemTypeFromString`）——所以剪映必须用 `build_capcut_fcpxml.py` 生成的无 multicam 版（spine 直接放 asset-clip，带 lane/offset），用 `build_fcpxml.py` 的 multicam 版导入会得到**空时间线**。

**要在剪映里直接多机位剪辑（保留角度切换 + 上方普通轨可挪可看素材编号），用 `build_capcut_draft_31.py` 生成剪映原生多机位草稿（3+1 布局）**：主时间线 = **轨0 = 多机位轨（1 段，进内按 1/2/3 切角度，放**主轨道**）+ 轨1/2/3 = A/B/C 三条普通 video 轨（514/508/480 段，对齐偏移在 target.start，素材文件名即编号可对场记单）**（用户 2026-08-21 在剪映里手动调整后确认的最终形态：多机位放主轨、普通轨在上）。这是**最终验证成功的 3+1 结构**，历经机制 A/组合引用/占位素材/磁吸/媒体丢失全部失败后定稿，详见 references/capcut-jianying-adapter.md 与下方硬规则。

剪映多机位草稿的硬规则（全部 2026-08-21 实测逆向 + codec 解码 + 用户对照草稿实证，违背必翻车）：
1. **最终成功结构（3+1，build_capcut_draft_31.py）**：
   - 主草稿 4 轨：**轨0 = 多机位轨（主轨，1 段覆盖全时长，可拖动）**，轨1/2/3 = A/B/C 普通轨（target.start=绝对对齐偏移，间隙保留）
   - **多机位轨放主轨（tracks[0]）是剪映的标准行为**——剪映加载后会自动把多机位轨挪到主轨（实测：剪映保存版轨序变 [1,514,508,480]），生成就直接按 [1,514,508,480] 轨序写（索引0=多机位，1/2/3=A/B/C）
   - **主草稿 materials.videos = 1502 真实素材 + 1 mc_video 共存（1503 个）**——"真实+mc 混放必损坏"是**错误结论**（那是 `{"draft":...}` 包裹键 + float 时长时代的现象；明文顶层直接是 draft 对象 + int 时长即可共存）
   - **主草稿 materials.drafts = [combination]（内嵌完整 3 角度轨 draft）**——这是多机位正常显示的关键，缺失 → **多机位轨媒体丢失**（实测 3 次）。combination 三个路径（draft_config_path/draft_cover_path/draft_file_path）用**同一个** `##_draftpath_placeholder_<UUID>_##/subdraft/<sub_id>/...` 前缀
   - 顶层**混合轨道模式键：`mixed_track_mode_on=true` + `version=360000` + 全轨 `type=mixed`**（主轨能落新/普通素材的必要条件，见规则 6）
   - 多机位轨 segment（轨0）：`material_id` = mc_video.id，`extra_material_refs` = **7 个**（[0]=combination.id，[1..6]=6 类 companions），**无 render_index / track_render_index**（可移动关键，见规则 7），hdr_settings.mode=1
   - 普通轨 segment：6 个 refs（每段独立一套 companions，共 1503 套/类），**无 render_index/track_render_index**（对齐 04:43 模板 track0 是 None）
   - **subdraft 根目录 + UUID 子目录各一份** draft_content.json + sub_draft_config.json——剪映按 `./subdraft/sub_draft_config.json`（根目录）解析，只有子目录版 → 媒体丢失
   - subdraft 顶层：1 轨引用同一个 mc_video（id 与主草稿一致）+ 7 refs（[0]=combination），顶层 combination 用 `##_subdraft_placeholder_<UUID>_##` 前缀（与主草稿的 `##_draftpath_placeholder_` 不同），内嵌 draft.id = **subdraft 文件夹名**；顶层 id = 独立 UUID（≠ 文件夹名）
   - **主草稿 mc_video 与 subdraft 顶层 mc_video 是同一个 id**（两边 check_flag=62978047，multi_camera_info.id 一致，cur_camera_track_id = 内嵌角度轨0 id）
   - **config.maintrack_adsorb = false（磁吸开关，必须在草稿 config 里显式写 false）**——磁吸打开时剪映自动压缩主轨间隙 → 普通轨错位（用户两个对照草稿实证：磁吸打开版 config 无此字段、第2段 target.start 被吸到紧贴；关闭版 config={"maintrack_adsorb":false}、间隙保留）。磁吸是**草稿级配置**（存 config），不是应用级偏好
   - meta type18（组合）file_Path = `./subdraft/sub_draft_config.json`（根目录）
2. **subdraft 内嵌 draft.id 必须 = subdraft 文件夹名**——剪映靠这个建立 combination ↔ 内嵌 draft 的关联。内嵌 draft id ≠ 文件夹名时剪映关联失败、主草稿退化成空草稿。
3. **主草稿 combination 的 id 与 subdraft 顶层 combination 的 id 相同**（双份同一组合），内嵌同一份 draft；sub_draft_config.json 的 id/project_id = 文件夹名。
4. **禁止预注册 `common_attachment/attachment_id_mapping.json`**——剪映读取阶段直接拒绝草稿（"草稿损坏"）。
5. **macOS 外置盘（PSSD）写文件会自动生成 `._*` AppleDouble 文件**，剪映解析子草稿会被干扰 → 生成完必须全目录清理 `._*`（rsync --exclude 不够，写入时就产生了）。
5.5. **剪映是沙盒应用：fcpxml 导入"素材未链接/弹窗/空时间线"先查权限，别查路径**（2026-08-23 人不狠实证）：素材在剪映从未授权过的路径（新外置盘/新目录）时，asset 全部登记成功、src 解码正确、文件全部存在，但**时间线空轨**（draft_info 1 条空轨 + name 用 project name 而非文件名）。授权（系统设置→隐私与安全性→文件与文件夹，或导入时弹窗允许）后**重新导入同一份 fcpxml 即成功**，无需改任何文件。路径字符（书名号/全角逗号/双空格/中文）不是问题——剪映 urlDecode 标准百分号解码，与可导入的老版 XML src 逐字节一致。
6. **多机位主轨"钉死"锁定 ⇄ 可移动**（用户 2026-08-21 实机：同一份草稿钉死 → 按规则改后可拖动，剪映验证通过）：
   - **钉死根因**：剪映把主轨多机位组合按 `render_index` 切分成多段，判定为"可切开的浮动组合段" → 锁死无法移动。触发条件是主轨 MC 段**带 render_index 且轨道 flag=2**（旧 build 版：track0 flag=2、render_index=0、check_flag=63502335）。
   - **可移动正确结构（与 8月20日 可移动参照逐字段一致）**：
     - 主轨 track0 = **flag=None（删除 flag 字段）+ 1 整块 MC 段 + 无 render_index / track_render_index**
     - 普通轨 track1/2/3 = **flag=2**
     - 主草稿 MC check_flag = **62978047**（与 subdraft 顶层一致；63502335 = 钉死版，勿用）
     - config：**`maintrack_adsorb=false` + `use_float_render=true`**；顶层 **`render_index_track_mode_on=true`**
     - **混合轨道模式（顶层 `mixed_track_mode_on=true` + `version=360000` + 全轨 `type=mixed`）**——主轨要能落**新素材/普通素材**必须补这三样，缺则剪映主轨（普通 video 轨模式）不接受素材落上去（用户 2026-08-21 实测：无这三样 → 连新素材都拖不进主轨；补上后 → 可拖）。**注意与"钉死锁定"是两回事**：钉死=主轨 MC 切开变浮动段拖不动；混合轨道键=主轨本身能否接受外部素材落下。
   - **铁证**：8月20日（可拖动）与新示例项目（修复后可拖动）逐字段核对完全一致；钉死版与新示例项目唯一差异集中在以上字段。普通轨段 render_index 有无不影响可移动（参照有、新示例项目无，均可拖动）。反推已验证：旧版主轨 MC 被剪成 7 段各带 render_index = 钉死；修成 1 整块无 render_index = 可拖动。
7. **剪映编辑后的草稿用官方 AES-GCM 加密**，用 `capcut_draft_codec.py` 解码看剪映真实写入——**验证多机位是否识别成功的证据闭环**（加载前明文、加载/保存后加密；保存后结构=剪映接受的结构）。诊断媒体丢失：对比剪映保存版 subdraft 根目录是否出现自动补的文件、meta type18 是否新增条目，即剪映实际解析路径。

## 脚本（scripts/，全部读 config.json，换项目无需改代码）

- `project_config.py` — 项目参数模块：自动探测帧率/分辨率/旋转/音频/天/相机目录；`sec_to_ticks`/`fr` 精确换算
- `make_index.py` — 盘点：ffprobe 提取时长/尺寸/TC/创建时间 -> index/durations/tc.tsv（大小写不敏感，覆盖 mp4/mov/mxf/mts/图片/音频）
- `sync.py` — 同步引擎：互相关 + TC 先验 + 鲁棒拟合，输出 positions_*.tsv（机位数/帧率自动适配）
- `extract_parallel.py` — ffmpeg 并行提取 16k mono f32 音频缓存
- `compress_gaps.py` — 压缩"三机全停"时段，输出 *_compressed.tsv（保持机间同步）
- `build_fcpxml.py` — 生成 FCPXML 1.8（resources media + event project/mc-clip/asset-clip，整帧吸附）
- `build_capcut_fcpxml.py` — 生成剪映专用 FCPXML 1.8（spine 直接放 asset-clip，带 lane/offset，无 multicam/gap；剪映只认 asset-clip）
- `build_capcut_draft_31.py` — **生成剪映原生 3+1 多机位草稿（最终定稿，用户 2026-08-21 验证通过 + 可拖动 + 主轨可落新素材）**：主草稿 4 轨 = **多机位轨放主轨（索引0，1 整块，7 refs 含 combination，flag=None、无 render_index）+ A/B/C 普通轨（索引1/2/3，flag=2，514/508/480 段，对齐偏移在 target.start，素材文件名可读）**；全部轨 `type=mixed` + 顶层 `mixed_track_mode_on=true` + `version=360000`（混合轨道模式，主轨可落新/普通素材，见规则 6）；主草稿 videos=1503（1502 真实+1 mc）、drafts=[combination]（内嵌 3 角度轨）、config.maintrack_adsorb=false + use_float_render=true、顶层 render_index_track_mode_on=true、MC check_flag=62978047；subdraft 根+子目录双份文件；复制到剪映草稿根目录即可打开进多机位剪辑（按 1/2/3 切换，主轨可拖动、可落新素材）。**补充 2026-08-23：多机位骨架构型从 `capcut_draft_schema.json` 加载，不再引用本机剪映模板/示例项目路径**
- 早期 `build_capcut_draft_1track.py` 仅存在于技能历史研究中，不随镜序发行，也不是当前可用入口；当前剪映多机位草稿使用 `build_capcut_draft_31.py`
- `build_capcut_test_draft.py` — 生成"多段测试"草稿（每角度 2 段真实素材，验证多段角度轨）
- `capcut_draft_codec.py` — 剪映官方加密草稿编解码（AES-GCM，密钥/IV 内嵌固定偏移；本机 11.3.0 实测 24/24 解码成功）；CLI 可解码草稿并输出多机位识别摘要，是"剪映加载后验证"的证据工具
- `validate_fcpxml.py` — **交付前常设校验**：帧边界（tick % frame_ticks==0）、素材可达（src/pathurl 解 percent 后存在）、引用完整（mc-clip→media、asset-clip→asset 等）、结构（mc-angle 内 clip 单调、spine 按 lane 分组不重叠）。`python3 validate_fcpxml.py <out.fcpxml> <BASE>`，PASS 退出 0 / FAIL 退出 1
- `build_pr_xml.py` — 生成 Premiere xmeml v4（每机位 1 视频轨+1 音频轨，clipitem 内联 file）

## 交付结构

`交付/` 下三件套：`*_final.fcpxml`（FCP 用）、`*_capcut.fcpxml`（剪映用）+ 尽力生成原生 `*_capcut_draft/`、`交付报告.md`（同步结果表、间隙策略、使用步骤）。脚本与位置表归档到 `同步脚本/`。交付文件放自己的工作目录，不要散到素材盘根目录。

**通用化（2026-08-23）**：本 skill **不依赖任何本机路径/机器特定项目**。`config.json` 只须填 `BASE`（素材根）；`OUT_DIR` 缺省自动取 `{BASE}/交付`，交付目录不能写进素材根时给出预检警告。`build_capcut_draft_31.py` 的多机位骨架构型从随脚本分发的 `capcut_draft_schema.json`（纯字段形状 skeleton）加载，不再引用本机剪映模板；剪映草稿根目录用 `find_draft_root()` 动态探测，`draft_cover.jpg` 属具化占位由脚本内联生成。换机器/换项目只改 `config.json` 即可全链路复用，交付前跑 `validate_fcpxml.py` 自检。
