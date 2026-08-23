# 适配剪映（JianyingPro / CapCut）— 研究结论

2026-08-21 基于本机剪映专业版 11.3.0（`/Applications/VideoFusion-macOS.app`，
bundle `com.lemon.lvpro`）+ 网络交叉验证（bilibili 官方群文档、GitHub
pyJianYingDraft / capcut-cli 文档）实测整理。

## 一句话结论

剪映**能直接用**我们交付的 FCPXML：文件导入对话框明确支持
`*.fcpxml *.fcpxmld *.prproj`。但有两个硬约束（均反汇编实证）：

1. **版本必须 ≥1.8**（见下），输出 1.7 会弹 `pc_fcpxml_version_too_low`
   （"FCPXML版本过低"）。
2. **剪映只认 `asset-clip` 作为时间线片段**，不认 `mc-clip`/`multicam`/
   `gap`/`clip`/`title`/`ref-clip`/`sync-clip`。因此：
   - `build_fcpxml.py` 输出的 multicam 版（spine 里是 mc-clip）导入剪映后
     **时间线为空**（spine 里每个元素都被跳过）。
   - 剪映必须用专用生成器 `build_capcut_fcpxml.py` 输出**无 multicam 版**：
     spine 里直接放 asset-clip（带 lane/offset），间隙靠 offset 定位。

真正的"多机位片段"只能在剪映应用内重建（新建多机位片段，6.8 起全量，
当前 11.x 有）——XML 交换只能得到"多轨普通片段"。

## 时间线为空的实证（本机 app 反汇编，决定性）

剪映 11.3.0 的 FCPXML 导入核心在 `libVECreator.dylib`（符号表完整，未混淆）：

- 时间线片段类型映射 `FCPXMLEnumTransfer::transferStoryItemTypeFromString`
  只把 `asset-clip`/`video`/`audio`/`spine` 映射到 StoryItemType 枚举；
  `mc-clip`/`clip`/`gap`/`title`/`ref-clip`/`sync-clip` 全部返回 0（跳过）。
  全库字符串搜索确认没有 `mc-clip`/`multicam`/`mc-angle` 的解析分支。
- `storyItemFromFCPXML` 读取的 asset-clip 属性：`ref`/`name`/`lane`/
  `offset`/`start`/`duration`/`enabled`/`role`。
- 时间值用 `FCPXMLUtility::microSecondFromFCPXMLTime` 把 FCP 时间字符串
  （如 `116000/50000s`）转微秒，所以 offset/duration 的 `{tick}/{den}s`
  格式剪映能正确解析。
- 结论：**spine 里直接放 asset-clip（带 lane + offset）是剪映唯一能识别
  的时间线结构**；`FCPXMLv1_8.dtd` 的 spine 内容模型 `(%clip_item; |
  transition)*` 包含 asset-clip，所以这在 FCPXML 层面同样合法。

## 版本门槛的实证（本机 app 反汇编，决定性）

剪映 11.3.0 的 FCPXML 导入核心在 `libVECreator.dylib`（符号表完整，未混淆）：

- 入口 `DraftTranslator::generatorDraftFromFCPXML` 用 **pugixml** 解析
  （`pugi::xml_document::load_file`），不是 Apple 的 XML 栈
- 版本检查逻辑（arm64 反汇编）：
  ```
  97ccb6c: cmp  w19, w20        ; w19=文件 version 属性编码, w20=1.8 编码
  97ccb70: b.hs 0x97ccb7c       ; if (文件版本 >= 1.8) 继续导入
  97ccb74: mov  w8, #0x6        ; else 返回错误码 6
  97ccb78: b    0x97cc9f0       ; → 触发 pc_fcpxml_version_too_low
  ```
- 版本编码 `VersionCodeUtils::VersionStringToCode`（Qt `QVersionNumber`）：
  `code = major<<16 | minor<<8 | patch`，所以 `1.7=0x010700`、`1.8=0x010800`
- 比较是 `文件版本码 >= 0x010800`，即 **≥1.8 才通过**；1.7 及以下一律拒绝
- 解析端 `FCPXMLReader::fcpDocumentFromFCPXML` 只读这些节点/属性：
  `resources` 下的 `format`(id/name/width/height/colorSpace/frameDuration)、
  `asset`、`media`，以及 `library/event/project`、各元素 `id`/`name`/`src`。
  **不读 `uid`/`modDate`**——OTIO 1.8 样例里的这两个属性是可选元数据，
  剪映不依赖，可省略
- 与 OpenTimelineIO 的启发一致：OTIO fcpx 适配器（otio-fcpx-xml-adapter）
  写入端硬编码 `version="1.8"`（`fcpx_xml.py` 第 134 行），解析端不检查
  version 属性只看结构。OTIO 作为行业标准写 1.8，剪映也卡 1.8，两边对齐

结论：**FCPXML 版本号必须 ≥1.8**。我们的 `build_fcpxml.py` 输出 1.8 即可，
无需补 uid/modDate（剪映不读）。

## 证据（本机 app 语言包实测）

`VideoFusion-macOS.app/Contents/Resources/po/zh-Hans.po` 中：

- `pc_fcpxml_prproj` → `"FCPXML, Adobe Premiere Pro 项目 (*.fcpxml *.fcpxmld *.prproj)"`
  —— 导入对话框过滤器，FCPXML 直接受支持
- `pc_fcproj_imported_successfully` → `"Final Cut项目导入成功"`
- `pc_fcpxml_version_too_low` → `"FCPXML版本过低"`（version<1.8 时触发，见上）
- `pc_multi_camera_create_compound` → `"新建多机位片段"`
- `pc_multi_camera_angles_four/nine` → 4/9 机位
- `pc_multi_camera_alignment` → `"对齐方式"`；`"声音"`/`"时间码"`/`"自动"`
- `pc_multi_camera_automatically_correct` → `"自动校正各机位素材色彩形成一致风格"`

## 推荐路径（按优先级）

### 路径 A：直接导入剪映版 fcpxml（首选，5 分钟验证）

**必须用 `build_capcut_fcpxml.py` 生成的 `*_capcut.fcpxml`**（spine 直接放
asset-clip），**不要**用 `build_fcpxml.py` 的 multicam 版（spine 里是
mc-clip，剪映会得到空时间线）。

1. 打开剪映专业版 → 草稿页 → 右上角 **导入 → 导入工程**（或 文件 → 导入工程）
2. 选 `示例项目_两天三机位_音频同步_capcut.fcpxml`
3. 预期结果：
   - 时间线按 asset-clip 的 offset 落轨，lane=1/2/3 对应 A/B/C 三机位，
     两天顺序合并、间隙保留
   - 是"多轨普通片段"，无角度切换功能（剪映内可重建多机位片段，见路径 B）
4. 已知风险（社区反馈）：变速（speed/retime）导入后可能丢失；大量 clip
   的 in/out 精度需抽查。若导入后时间线错乱，退回路径 B/C。

### 路径 B：剪映内重建多机位片段（保留角度切换的唯一途径）

因为多机位片段只能应用内创建（没有任何公开工具能程序化生成），步骤：

1. 剪映中导入 A/B/C 三个相机的素材（或直接从素材库拖入——用户素材目录树
   已在剪映虚拟存储中：`示例拍摄日/A1...C2`、`8.14示例项目/A3/B3/C3`）
2. 全选同一天的三个机位素材 → 右键 → **新建多机位片段 → 新建**
   - 对齐方式选 **时间码** 或 **自动**；由于我们的素材已音频同步到同一时间轴，
     对齐验证会非常快（剪映对齐失败会提示"部分片段对齐失败，请双击进入
     多机位片段手动对齐"）
3. 多机位片段拖入时间线，播放时按 **1/2/3**（或点击画面）切换角度
4. 跨天：第2天素材重复一次新建多机位片段，或把两天的多机位片段顺序拼接
   （需要用户手动把第2天片段对齐到第1天末尾——剪映不支持跨片段自动衔接）

注意：剪映多机位对齐基于声音/时间码**应用内重新计算**，不会自动读取我们
FCPXML 里的偏移值。若剪映自动对齐失败（例如某相机音轨音量过低），需在
多机位片段内手动拖动对齐——我们的交付报告里 delta_B/delta_C 偏移值可作
参考（8.13: B=-41.29s C=-23.51s；8.14: B=+76.60s C=+102.73s，A 为参考）。

### 路径 C：程序化生成剪映草稿（保真但不保留多机位）

从 positions TSV 直接生成 `draft_content.json`（3 视频轨 + 3 音频轨），
所有时间转**微秒**（×1e6）。已验证的字段结构见下方。适用于：必须保留全部
1502 个 clip 的精确 in/out 与间隙、且不要求角度切换的交付。

限制（社区实证 + 本机实测）：
- 剪映专业版 6.0+ 的 `draft_info.json` / `draft_meta_info.json` 是
  **AES 加密**的（本机 11.3.0 实测 draft_info.json 为密文）；`subdraft/
  draft_content.json` 是明文 JSON（本机实测可读）
- 国际版 CapCut 保持明文，程序化生成首选；剪映 6.0+ 生成的草稿可能被
  10.x 报"内容已损坏"，需先复制草稿验证
- pyJianYingDraft（Python，4.2k★）支持 5.9 与 10.8，是成熟参考；
  capcut-cli（Node）有 `compile`/`register`/`lint`，可注册草稿到根目录
  `root_meta_info.json`

### 路径 D：程序化生成剪映原生多机位草稿（推荐，保留角度切换）

> **⚡ 最终定稿（2026-08-21 用户验证通过）：`build_capcut_draft_31.py` 生成
> 3+1 布局**（主草稿 4 轨 = 轨0 多机位主轨 + 轨1/2/3 普通 A/B/C；videos=1502 真实
> +1 mc 共存；**主草稿 materials.drafts=[combination] 内嵌完整 3 角度轨 draft**
> ——这是媒体丢失修复的关键；多机位轨 segment 7 refs（[0]=combination）+
> render_index=3；config.maintrack_adsorb=false；subdraft 根+子目录双份）。
> **下方"机制 A/机制 B"的历史记录只作踩坑参考，不要照抄**——机制 A
> （组合引用、不内嵌 draft、videos 只放真实素材、顶层 id=文件夹名）和
> 机制 B（1-track）都是**已被验证失败或过时的结构**。最终结构 = 机制 B 的
> 关联方式（主草稿内嵌 combination + 7 refs）**嫁接到 4 轨 3+1 布局**。
**这是用户"直接在剪映里多机位剪辑"的最优解**：`build_capcut_draft_31.py`
把**我们已经算好的对齐位置**直接写进剪映原生草稿，绕过剪映自带的同步步骤
（剪映同步实测做得很差：1502 轨每条 1 段、target 全堆在 0 点）。

输出：`{OUT_DIR}/{PROJ_NAME}_音频同步多机位_capcut_draft/`（剪映草稿目录）。
用户把该目录复制到剪映草稿根目录（`~/Movies/JianyingPro/User Data/Projects/
com.lveditor.draft/`）并注册到 `root_meta_info.json`，即可在剪映中打开，
**直接进入多机位剪辑**（播放时按 1/2/3 切换角度）。

结构（本机 11.3.0 实测逆向，**剪映真实创建的多机位** `多机位演示/
subdraft/4F5267B9-...` 为金标准）：

```
<草稿名>/
├── draft_info.json          明文主时间线（未编辑过的导入草稿是明文）
├── draft_meta_info.json     素材注册表（draft_materials[0].value = 素材列表）
├── draft_agency_config.json {}
└── subdraft/<UUID>/         多机位片段内容载体
    ├── draft_content.json   明文！多机位片段结构（见下）
    └── sub_draft_config.json
```

`subdraft/<UUID>/draft_content.json` 关键结构（时间一律微秒）：

```json
{
  "id": "<独立 UUID，≠ 文件夹名（4F5267B9 实证：顶层 F827F5CD）>",
  "duration": 32706105529,
  "fps": 50.0,
  "source": "default",
  "render_index_track_mode_on": true,
  "tracks": [  // 顶层只有 1 条 video 轨，引用多机位素材本身
    { "type": "video",
      "segments": [{
        "material_id": "<materials.videos[0].id 多机位素材>",
        "source_timerange": {"start": 0, "duration": 32706105529},
        "target_timerange": {"start": 0, "duration": 32706105529},
        "extra_material_refs": [  // 7 个：combination + 6 个配套
          "<combination.id>",
          "<speeds[0].id>", "<placeholder_infos[0].id>",
          "<canvases[0].id>", "<sound_channel_mappings[0].id>",
          "<material_colors[0].id>", "<vocal_separations[0].id>"
        ],
        "hdr_settings": null, "render_index": 0, "track_render_index": 0,
        "visible": true
      }]
    }
  ],
  "materials": {
    "videos": [{  // 多机位素材（带 multi_camera_info，path 空）
      "id": "<uuid>", "material_name": "示例项目｜多机位片段",
      "duration": 32706105529, "width": 1080, "height": 1920,
      "check_flag": 62978047,
      "multi_camera_info": {
        "audio_open_track_id_list": ["<角度轨0 id>"],
        "cur_camera_track_id": "<角度轨0 id>",
        "id": "<独立 mci id>", "pre_compile_to_normal_video": false
      }
    }],
    "drafts": [{  // combination：内嵌 draft = 角度内容
      "type": "combination", "id": "<combination.id>",
      "draft_file_path": "##_subdraft_placeholder_..._##/draft_content.json",
      "draft": {
        "id": "<UUID 与文件夹同名>",
        "source": "default", "render_index_track_mode_on": true,
        "tracks": [  // 3 条 video 轨 = 3 机位（A/B/C）
          { "type": "video", "segments": [{
              "material_id": "<该机位素材 id>",
              "source_timerange": {"start": 0, "duration": 24480000},
              "target_timerange": {"start": 2320632, "duration": 24480000},
              "visible": true, "render_index": 0, "track_render_index": 0,
              "extra_material_refs": [  // 6 个：每角度一套配套
                "<speeds[i].id>", "<placeholder_infos[i].id>",
                "<canvases[i].id>", "<sound_channel_mappings[i].id>",
                "<material_colors[i].id>", "<vocal_separations[i].id>"
              ]
            }]
          }
        ],
        "materials": {
          "videos": [/* 各机位素材，绝对路径 */],
          "speeds": [/* 每角度 1 个 */], "placeholder_infos": [/* 每角度 1 个 */],
          "canvases": [/* 每角度 1 个 */],
          "sound_channel_mappings": [/* 每角度 1 个 */],
          "material_colors": [/* 每角度 1 个 */],
          "vocal_separations": [/* 每角度 1 个 */]
        }
      }
    }],
    "speeds": [/* 顶层 1 个 */], "placeholder_infos": [/* 顶层 1 个 */],
    "canvases": [/* 顶层 1 个 */],
    "sound_channel_mappings": [/* 顶层 1 个 */],
    "material_colors": [/* 顶层 1 个 */],
    "vocal_separations": [/* 顶层 1 个 */]
  }
}
```

**主草稿 `draft_info.json` 有两种机制，按布局选择，不可混用**：

**机制 A：3+1 布局（本脚本默认，用户 2026-08-21 指示）——"组合引用"结构**（旧版 bak_v2，剪映 04:43 加载保存成功实证）：
- `tracks` = **多机位轨（索引 0 = 主轨道）+ 3 条普通 video 轨（A/B/C，主轨之上，
  索引 1/2/3，真实素材，`target_timerange.start` = 时间轴绝对位置，两天顺序
  合并、间隙保留）**；多机位轨 1 个 segment 引用 **combination.id**
  （`material_id` = combination.id、`extra_material_refs` 无/空、
  source/target = 0 → 总时长）
- **轨道顺序（关键，2026-08-21 用户明确指示）**：剪映逻辑 = **主轨道
  （tracks[0]）删除间隙**（旧布局把 A 放索引 0 → A 被压缩成连续布局、与 B/C
  错位，实测 04:43 保存版：轨0=0/24480000/50400000... 连续、轨1/2 保留间隙）。
  **多机位放主轨道**（1 段覆盖全时长、无间隙 → 剪映无间隙可删），**3 条普通轨
  放主轨之上**（非主轨保留间隙、位置与多机位内部角度轨完全一致）
- `materials.videos` = **只放真实素材（1502 个），不放 mc_video**
  （mc_video 只在 subdraft 的 materials.videos 里）
- `materials.drafts` = [combination]：**不内嵌 draft**（13 字段：
  id/type/name/combination_id/combination_type/draft_config_path/
  draft_cover_path/draft_file_path/formula_id/precompile_combination +
  aimusic_mv_template_info/category_id/category_name），`draft_file_path` 用
  **相对路径** `subdraft/<sub_id>/draft_content.json`（无占位符前缀）
- 主草稿**无** 6 配套（speeds 等为空数组）
- **subdraft 顶层 id = 文件夹名**（剪映靠它关联 combination ↔ subdraft；
  独立顶层 id → 组合被删、多机位消失，2026-08-21 实测；bak_v2 顶层 id=sub_id
  成功、剪映保存后顶层 id 仍是文件夹名 B3EEE341 实证）

**机制 B：1-track 金标准（剪映自己创建多机位后的形态，`多机位演示` codec 解码实证）**：
- 轨 segment `material_id` = mc_video.id（**不是** combination.id）、
  `extra_material_refs` = **7 个字符串 id**（combination.id + 6 配套）、
  `hdr_settings` = `{"mode": 1}`、source/target 只含 `duration`
- `materials.videos` = **[mc_video]（只有 1 个，path=""，带 multi_camera_info）**
- `materials.drafts` = [combination]：**必须内嵌完整 draft**（9 字段，
  `draft_file_path` 用 `##_draftpath_placeholder_<UUID>_##/subdraft/<sub_id>/...`
  前缀；subdraft 内组合用 `##_subdraft_placeholder_536E1D01-..._##` 前缀）
- `materials` 有 6 配套（极简对象、独立 id）
- **主草稿 mc_video 与 subdraft 顶层 mc_video 是两个独立对象**（不同 id、
  不同 multi_camera_info.id：金标准主草稿 5C1B096F/mci 7290E720、subdraft
  94282BF2/mci 9BD84B14；cur_camera_track_id 相同，都指向角度轨0）

**⚠️ 两套结构禁止混用（2026-08-21 实测"草稿损坏"根因）**：3+1 布局用机制 B
（`materials.videos` 同时放真实素材 + mc_video、轨引用 mc_video.id + 内嵌
draft + 占位符路径）会让剪映**读取阶段直接拒绝草稿**——draft_info.json 保持
明文、无 `.backup` 生成，草稿列表显示"草稿损坏"。真实素材（1502 个）在
`draft_meta_info.json` 注册（两种机制都要）。

踩坑史（全部实测，避免重蹈）：
- 轨3 引用 combination + `materials.drafts`=[combination 仅路径无内嵌] + 无
  配套 → 剪映把 combination 删除、轨3 被删成空轨（"普通3轨道"，99AB94D7）
- 轨3 引用 mc_video + `materials.drafts`=[] → 轨3 保留为 mc_video 占位，
  剪映无从得知 subdraft 位置 → 不创建 combination（"有名字的占位、无法编辑"，
  FC8ED596/旧多段测试）
- **3+1 混用金标准主草稿结构（2026-08-21 实测"草稿损坏"根因）**：主草稿
  `materials.videos` 同时放真实素材（1502 个）+ mc_video、轨引用
  mc_video.id + 7 refs + combination 内嵌完整 draft + 占位符路径 → 剪映
  **读取阶段直接拒绝草稿**（"草稿损坏"：draft_info.json 保持明文、无
  .backup 生成、draft_settings 的 real_edit_seconds=0）。3+1 必须用机制 A
  （组合引用：轨 → combination.id、不内嵌、相对路径、videos 只放真实素材）
- **subdraft 顶层 id ≠ 文件夹名 → 组合被删、多机位消失**（2026-08-21 实测；
  bak_v2 顶层 id=sub_id 成功、剪映保存后顶层 id 仍是文件夹名 B3EEE341）。
  金标准（机制 B，剪映自己写的路径）顶层 id 才是独立 UUID（4F5267B9 顶层
  F827F5CD ≠ 文件夹名）——两条写路径的关联机制不同，勿混用
- **普通轨不能放主轨道（索引 0）**——剪映主轨道删除间隙，A 放索引 0 会被
  压缩成连续布局、与 B/C 错位（04:43 保存版实证：轨0=0/24480000/50400000...
  连续、轨1/2 保留间隙）。用户 2026-08-21 明确指示：多机位放主轨道，3 轨放
  主轨之上（间隙保留、与多机位内部角度轨位置完全一致）
- 1-track 金标准机制（机制 B）**只在主草稿只有 1 条多机位轨时可用**
  （`_backup_1track/多段测试_bak_0821_141432`，剪映 14:07 保存成功实证）
- 内嵌 draft 缺失 = 组合不被识别为多机位的根因（机制 B 场景）；机制 A 的
  combination 本身不内嵌（剪映靠 draft_file_path 相对路径找 subdraft）

对齐语义（关键，与剪映真实 4F5267B9 对比）：
- **剪映真实多机位**：角度轨 segment `source_timerange.start` = **0**（从素材
  开头播放），`target_timerange.start` = **对齐偏移**（时间轴位置）
- 角度轨 `visible` 全部 **true**（多机位靠 `cur_camera_track_id` 切换当前
  角度，不靠 visible 隐藏非当前角度）
- 角度轨 `render_index` = **0/2/1**（当前角度=0 在顶层，其他逆序），
  `track_render_index` = 0/1/2（渲染堆叠顺序，复刻剪映模式）
- 顶层 segment `render_index` = 0、`track_render_index` = 0、`visible` = true、
  `hdr_settings` = null

**识别多机位的必要条件**（实证：剪映加载缺配套的草稿后不会自动补全）：
- 多机位片段结构在 **subdraft** 里（剪映加载时通过 combination 的
  `draft_file_path` 找到 subdraft 文件，再从 subdraft 的 materials.drafts
  找到内嵌 draft = 3 角度轨）
- **subdraft 顶层 segment `extra_material_refs` = 7 个字符串 id**（combination
  + 6 配套，金标准实证是字符串数组；机制 A 旧版曾用 1 个 [combination_id]
  也成功，7 个最稳妥）
- **角度轨 segment `extra_material_refs` = 6 个**（每角度一套配套，字符串数组）
- 配套 materials（speeds/placeholder_infos/canvases/sound_channel_mappings/
  material_colors/vocal_separations）在 subdraft 顶层和内嵌 draft 里都有
- mc video 带 `multi_camera_info`（cur_camera_track_id = 角度轨0 id）
- **subdraft 内嵌 draft.id = 文件夹名**（剪映靠它关联 combination ↔ 内嵌
  draft；实证：旧版"多段测试"草稿内嵌 draft.id ≠ 文件夹名时，剪映关联
  失败、主草稿退化成空草稿——"无内容"。金标准 4F5267B9 与旧草稿
  99AB94D7 内嵌 draft.id 均 = 文件夹名）
- draft_content.json **顶层 id = 文件夹名（机制 A 组合引用必须）**；金标准
  （机制 B，剪映自己创建的写路径）顶层 id 才是独立 UUID（4F5267B9 顶层
  F827F5CD ≠ 文件夹名）——两条写路径的关联机制不同，勿混用。
  sub_draft_config.json 的 id/project_id 仍 = 文件夹名
- 主草稿多机位轨 segment 的 `extra_material_refs` = 7 个是**机制 B
  （1-track）**的要求；机制 A（3+1 组合引用）不要求（bak_v2 成功）——
  7 refs 只在轨引用 mc_video.id 时需要
- **禁止预注册 `common_attachment/attachment_id_mapping.json`**——金标准
  附件里剪映创建多机位时（4F5267B9 03:55）注册了 2502=主轨3 seg、
  2503/2504/2505=3 个角度 seg；但剪映加载外部草稿时只注册主草稿 segment、
  从不注册角度 seg。曾假设"预注册角度 seg 可补缺口"，实测**预注册让剪映
  读取阶段直接拒绝草稿**（draft_info.json 保持明文、无 .backup 生成，
  草稿列表显示损坏，2026-08-21 用户反馈"草稿损坏"实证）。该文件是剪映
  自己维护的，外部不要写。

## 剪映官方加密草稿编解码（capcut_draft_codec.py）

剪映编辑过的草稿 `draft_info.json` 是**官方加密容器**：AES-GCM 加密的
JSON，密钥 32 字符 + IV 16 字符（62 位字母数字表）以 4 字符为单位内嵌在
容器文本固定偏移（key: 0/7/20/33/40/47/59/66，iv: 76/89/99/127，单位 4
字符块）。`scripts/capcut_draft_codec.py` 实现解码/编码/自动加载（明文
直接解析，加密自动解码），本机 11.3.0 实测 24/24 个编辑过的草稿解码成功。

用途：**验证剪映加载后到底对草稿做了什么**（证据闭环，不靠猜）——
把生成草稿复制进剪映打开，剪映保存后 draft_info.json 变加密，解码看：
轨3 是否仍带 7 个 extra_material_refs、materials.drafts 是否仍内嵌 3 轨 =
多机位识别成功；组合被删/轨3 变占位 = 识别失败，看差异定位。

注册到剪映（复制即可，剪映扫描目录自动注册）：
1. 复制草稿目录到 `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`
2. 重启剪映（或刷新草稿列表）——实测剪映启动时自动扫描草稿根目录并注册
   到 `root_meta_info.json`，无需手动改该文件
3. 打开草稿：时间线是 3 轨已对齐的多机位片段，播放时按 1/2/3 切换角度

## 剪映草稿格式速查（本机实测，微秒单位）

```
~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/<草稿名>/
├── draft_info.json          加密（剪映6.0+）；5.9- 为明文 JSON
├── draft_meta_info.json     加密；素材库注册
├── draft_virtual_store.json 明文；素材目录树（用户素材已注册）
├── subdraft/
│   ├── draft_content.json   明文时间线！tracks/segments/materials
│   └── <UUID>/              复合片段/多机位片段实例（子时间线）
└── Timelines/<UUID>/        老版本布局
```

`subdraft/draft_content.json` 关键结构（时间一律微秒）：

```json
{
  "canvas_config": {"height": 1920, "ratio": "original", "width": 1080},
  "duration": 1635305000000,
  "fps": 50.0,
  "id": "<uuid>",
  "new_version": "87.0.0",
  "version": 360000,
  "materials": {
    "videos": [{
      "id": "<uuid>",
      "path": "/path/to/media/day/A1/A001C001_260813HH.MP4",
      "type": "video",
      "duration": 1224000000,     // 微秒
      "width": 1080, "height": 1920,
      "material_name": "A001C001_260813HH",
      "has_audio": true,
      "crop": {"lower_left_x": 0, "lower_left_y": 1, "lower_right_x": 1,
               "lower_right_y": 1, "upper_left_x": 0, "upper_left_y": 0,
               "upper_right_x": 1, "upper_right_y": 0},
      "crop_ratio": "free", "crop_scale": 1.0,
      "source": 0, "check_flag": 62978047
    }],
    "audios": [], "speeds": [], "canvases": [],
    "sound_channel_mappings": [], "vocal_separations": [],
    "beats": [], "texts": [], "stickers": [], "transitions": [],
    /* 40+ 类型数组，生成时补空数组即可 */
  },
  "tracks": [
    {
      "attribute": 0, "flag": 0, "id": "<uuid>",
      "is_default_name": true, "name": "",
      "type": "video",            /* 或 "audio"；每轨一个 segments 列表 */
      "segments": [{
        "id": "<uuid>",
        "material_id": "<materials.videos[].id>",
        "source_timerange": {"start": 0, "duration": 1224000000},
        "target_timerange": {"start": 116000000, "duration": 1224000000},
        "speed": 1,
        "clip": {"alpha": 1, "flip": {"horizontal": false, "vertical": false},
                 "rotation": 0, "scale": {"x": 1, "y": 1},
                 "transform": {"x": 0, "y": 0}},
        "render_index": 0, "track_render_index": 0,
        "visible": true, "volume": 1, "last_nonzero_volume": 1,
        "reverse": false, "is_placeholder": false, "group_id": "",
        "keyframe_refs": [], "common_keyframes": [],
        "responsive_layout": {"enable": false, "horizontal_pos_layout": 0,
                              "size_layout": 0, "target_follow": "",
                              "vertical_pos_layout": 0},
        "hdr_settings": null
      }]
    }
  ]
}
```

转换要点（FCPXML/xmeml → 剪映草稿）：
- 秒 → 微秒：`µs = round(seconds * 1_000_000)`（帧级精度即够：1 帧 @50fps
  = 20,000µs）
- 每个机位一条 `type:"video"` 轨道 + 一条 `type:"audio"` 轨道（A/B/C = 6 轨）
- `target_timerange.start` = 时间轴绝对位置（保留间隙）；`source_timerange`
  = 源文件内 in/out
- 素材直接引用外部路径（新版剪映不复制素材，靠 draft_virtual_store 注册）

## 决策表

| 需求 | 推荐 |
|---|---|
| 快速看同步结果 | A：导入 `*_capcut.fcpxml`（build_capcut_fcpxml.py 生成） |
| 需要在剪映里多机位剪辑 | **D：生成剪映原生 3+1 多机位草稿（build_capcut_draft_31.py，推荐）** |
| 需要角度切换剪辑 | D（程序化生成，已对齐）或 B（剪映内重建，需重新同步） |
| 必须无损搬全部 clip | C：生成剪映草稿（国际版 CapCut / 剪映 5.9） |
| 只是出片不编辑 | 从 FCPXML 在 FCP/PR 渲染成片，导入成片 |

## 避坑

1. **FCPXML 版本必须 ≥1.8**（剪映硬门槛，反汇编实证）。输出 1.7 会弹
   "FCPXML版本过低"。`build_fcpxml.py` / `build_capcut_fcpxml.py` 已固定
   输出 1.8。
2. **剪映只认 asset-clip，不认 mc-clip/multicam/gap**（反汇编实证）。
   `build_fcpxml.py` 的 multicam 版导入剪映会得到**空时间线**。剪映必须用
   `build_capcut_fcpxml.py` 生成的无 multicam 版（spine 直接放 asset-clip，
   间隙靠 offset 定位，不用 gap 元素）。
3. 不要指望 mc-clip/multicam 跨软件保留——剪映、PR、FCP 的"多机位"都是
   各自应用内创建的原生结构，XML 交换只会得到"多轨普通片段"。**要在剪映里
   保留角度切换，用 build_capcut_draft_31.py 生成原生 3+1 多机位草稿（路径 D）**。
4. 剪映 FCPXML 导入会丢变速（社区实测），本交付无变速，不受影响。
5. 剪映 6.0+ 加密 draft_info.json，**但未编辑过的导入草稿是明文**，且
   `subdraft/draft_content.json` 始终明文——程序化生成多机位草稿（路径 D）
   完全可行，主草稿和 subdraft 都写明文。
6. 验证永远在复制的草稿上做，别动用户原草稿。
7. **多机位对齐语义**：角度轨 segment `source_timerange.start` = **0**（从素材
   开头播放）、`target_timerange.start` = **对齐偏移**（时间轴位置）。剪映自动
   同步失败的表现是 1502 轨每条 1 段、target 全堆在 0 点——这就是"剪映同步
   做得很差"的根源，路径 D 直接绕过它。
8. **多机位识别需要完整配套**：顶层 segment `extra_material_refs` = 7 个
   （combination + speeds + placeholder_info + canvases + sound_channel_mapping
   + material_color + vocal_separation），角度轨 segment = 6 个（每角度一套），
   配套 materials 在顶层和内嵌 draft 里都要有。缺配套时剪映**不会自动补全**
   （实测：加载缺配套的草稿后 extra_material_refs 保持 1 个、配套 materials
   保持 0 个），会退化成普通片段。
9. **角度轨 visible 全 true**：多机位靠 `cur_camera_track_id` 切换当前角度，
   不靠 visible 隐藏非当前角度。角度轨 `render_index` = 0/2/1（当前角度=0
   在顶层，其他逆序），`track_render_index` = 0/1/2。
