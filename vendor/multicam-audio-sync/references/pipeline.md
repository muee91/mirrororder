# 流水线详解

以两天×三机位（1502 个片段）实测为准。所有步骤在本地工作目录执行，音频缓存可再生。所有脚本读 `scripts/config.json`（BASE/WORK/OUT_DIR/manual），换项目只改这一个文件。

## 0. 项目参数（project_config.py）

自动探测（ffprobe）：
- 帧率/分辨率：取第一个视频的 r_frame_rate + rotation（±90° 交换宽高，竖拍返回显示方向尺寸）。
- 帧率精确表示：整数 fps（24/25/30/50/60）→ 每帧 1000 tick；NTSC（23.976/29.97/59.94）保留原始分数（24000/1001 等）→ 每帧 1001 tick，帧边界精确。
- 天目录：`示例拍摄日`→`813`、`2024-05-01`→`20240501`、`20240501`→`20240501`。
- 相机目录：`A1/B2/C3`、`CAM_A/cam-b/camera_c` 等；同一相机多张卡（A1+A2）合并为列表。
- 音频采样率/声道、机位列表。

探测失败或特殊素材在 `config.json` 的 `manual` 覆盖（fps/width/height/audio_rate/audio_ch/project_name/camera_name/out_name）。

## 1. 素材盘点（make_index.py）

遍历素材根目录（大小写不敏感，覆盖 mp4/mov/mxf/mts/图片/音频），对每个媒体提取：时长、尺寸、TC（`timecode` 标签，遍历所有 stream——Sony XAVC 的 TC 在 data stream）、创建时间。写入三个 TSV：`index.tsv`（id/day/cam/dir/file，day/cam 为显式列）、`durations.tsv`（dur/size）、`tc.tsv`（tc/creation）。

关键探测结论（本项目）：
- TC 机内连续：跨卡位置差 = TC 差 × 帧长（斜率 1.000）。
- TC 机间不可信：A/B 机 TC 差 ≈2s，真实偏移 −41s。
- C 机创建时间错乱（2020-12-31）→ 不能用文件时间对齐。

```bash
ffprobe -v error -show_entries format=duration,size:format_tags=timecode,creation_time \
        -of default=noprint_wrappers=1 file.MP4
```

## 2. 音频提取（ffmpeg 并行）

每 clip 提取 16kHz 单声道 float32 缓存（`audio/{id}.f32`）。~5GB/1500 片段，可删除后重生成。

```bash
ffmpeg -i file.MP4 -vn -ac 1 -ar 16000 -f f32le -acodec pcm_f32le out.f32
```

## 3. 互相关测偏移（sync.py 核心）

对一对片段 (a, b)：
- 降采样 16k→8k（`x[::2]`）
- 预加重 `x[1:] - 0.97*x[:-1]`（经典语音处理，提升对齐锐度）
- 减均值 + 单位范数归一化
- `scipy.signal.correlate(a, b, mode="full", method="fft")`
- 峰值位置 → lag = k − (len(b)−1)；**offset = −lag/sr，即 pos_a − pos_b**（见 pitfalls 1）
- 置信度 conf = |峰值| ÷ (峰值 ±5s 窗口之外 |c| 的中位数)

## 4. TC 先验候选配对

对每个 A 机片段，在 B/C 机中找 TC 落在 `TC_A + prior_delta ± margin` 的片段做候选，避免 O(n²) 全量相关。prior_delta 从**第一个正常片段**推出（跳过 dur<5s 的残留片段，见 pitfalls 2）。

## 5. 鲁棒联合拟合（joint_fit）

约束（off = 互相关测得的 pos_X − pos_Y）：
- AB: delta_B = tcA − tcB − off
- AC: delta_C = tcA − tcC − off
- BC: delta_C − delta_B = tcB − tcC − off

设计矩阵（delta = a·t + b，t 为 A 机时间轴）：
- AB 行 `[t, 1, 0, 0]`，AC 行 `[0, 0, t, 1]`，BC 行 `[-t, -1, t, 1]`
- 权重 w = clip(log10(1+conf), 1, 8)；IRWLS sigma-clip
- 预清洗：每族只保留 conf≥30 且距族内中位数 ±10s 的约束（防假峰拉偏）

实测结果：斜率≈0（恒定偏移），delta_B/delta_C 全天不变；MAD 15~22ms。

## 6. 交叉闭合校验

AB 中位数 + BC 中位数 必须 ≈ AC 中位数（三机闭环）。本项目残差 −2.1ms。这是"拟合没被假峰带偏"的最强证据。

## 7. 位置表

每个片段得到绝对时间轴位置 `pos` → `positions_{day}.tsv`（id/dir/file/dur/…/cam/pos）。

## 8. （可选）压缩三机全停时段

按用户决策。删掉无任何机位在录的时段，其后所有素材一起前移。验证：同活跃区间内配对偏移变化必须 = 0（本项目 991 对实测 0.000000s）。单机停机间隙不可删。

## 9. FCPXML 1.8（build_fcpxml.py）

见 references/fcpxml-structure.md。要点：单 format 资源（同格式素材共用一个）、asset id 按天唯一、全部时间值整帧吸附、event 级 mc-clip 让多机位出现在事件浏览器。**版本号固定 1.8**（剪映硬门槛 ≥1.8，见 capcut-jianying-adapter.md；FCP 官方有 FCPXMLv1_8.dtd，1.7 的合法结构在 1.8 下同样合法）。

**剪映专用变体（build_capcut_fcpxml.py）**：剪映只认 `asset-clip` 作为时间线片段，不认 mc-clip/multicam/gap（反汇编实证）。剪映版输出 `*_capcut.fcpxml`：spine 直接放 asset-clip（lane=机位序号、offset=绝对时间轴位置、间隙靠 offset 定位），不用 media/multicam/mc-clip/gap。FCP 用户仍用 build_fcpxml.py 的 multicam 版。

## 9b. 剪映原生 3+1 多机位草稿（build_capcut_draft_31.py，推荐给剪映多机位剪辑）

**这是"直接在剪映里多机位剪辑 + 上方普通轨可挪可看素材编号"的最优解**（用户 2026-08-21 验证通过）：把已算好的对齐位置写进剪映原生草稿，绕过剪映自带的同步步骤（剪映同步实测做得很差：1502 轨每条 1 段、target 全堆在 0 点）。

输出 `{OUT_DIR}/{PROJ_NAME}_音频同步多机位_capcut_draft/`（剪映草稿目录），复刻剪映 04:43 自己保存的 3+1 模板：
- 主草稿 `draft_info.json`（明文，顶层直接是 draft 对象、无包裹键、时长全 int）：**4 条轨** = **轨0 多机位轨（主轨，1 段覆盖全时长）+ 轨1/2/3 普通 video 轨（A/B/C，514/508/480 段，target.start=绝对对齐偏移、间隙保留、素材文件名可读）**（多机位放主轨是剪映标准行为，加载后剪映会自己挪到主轨，生成直接按 [1,514,508,480] 轨序写）；`materials.videos` = 1502 真实素材 + 1 mc_video（带 multi_camera_info，check_flag=63502335，path=""）；`materials.drafts` = [combination]（**内嵌完整 3 角度轨 draft**，三个路径用同一 `##_draftpath_placeholder_<UUID>_##/subdraft/<sub_id>/...` 前缀）；6 类 companions 各 1503 个（每段独立一套）；**config.maintrack_adsorb=false**（磁吸开关，否则主轨间隙被压缩）
- 多机位轨 segment（轨0）：material_id=mc_video.id、extra_material_refs=**7 个**（[0]=combination.id + 6 companions）、render_index=**0**（多机位轨在主轨=索引0）、hdr_settings.mode=1
- `subdraft/`：**根目录 + UUID 子目录各一份** draft_content.json + sub_draft_config.json（剪映按根目录 `./subdraft/sub_draft_config.json` 解析）；draft_content.json 顶层 1 轨引用同一 mc_video + 7 refs，顶层 combination 用 `##_subdraft_placeholder_<UUID>_##` 前缀、内嵌 draft.id=**文件夹名**、顶层 id=独立 UUID；内嵌 3 角度轨 source.start=0、target.start=对齐偏移、角度段 6 refs
- `draft_meta_info.json`：素材注册（type0=1502 素材，type18=1 组合，file_Path=./subdraft/sub_draft_config.json）；`sub_draft_config.json`：id/project_id=文件夹名

使用：复制目录到剪映草稿根目录（`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`）+ 重启剪映（自动注册到 root_meta_info.json）+ 打开草稿：上方 3 条普通轨（看素材编号、可挪动剪辑、对照场记单）+ 底部多机位轨（按 1/2/3 切换角度）。

⚠️ 生成后必须全目录清理 `._*` AppleDouble 文件（外置盘写入自动产生，剪映解析子草稿会被干扰）。

## 10. Premiere xmeml v4（build_pr_xml.py）

见 references/premiere-xmeml.md。

## 11. 全量校验

见 references/validation.md。校验不过不交付。
