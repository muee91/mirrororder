#!/usr/bin/env python3
"""生成剪映 3+1 布局多机位草稿（3 条普通轨 A/B/C + 1 条多机位主轨）。

结构基线来自剪映 close 保存成功的模板：
  `牛肉_音频同步多机位_capcut_draft_旧备份_043919`（04:43 剪映保存）。
可移动多机位主轨参照（2026-08-21 剪映实机）：
  `8月20日` —— 主轨 track0 放 1 整块多机位、能自由拖动，普通轨在其上。

最终已验证结构（不要再改！）：
  主草稿（draft_info.json，顶层直接是 draft 对象，无包裹键）：
    - 轨道序：track0 = 多机位主轨（1 整段），track1/2/3 = A/B/C 普通轨
      （514/508/480 段）。主轨 flag=None，普通轨 flag=2。
    - 主轨多机位段：material_id=mc_video，source/target.duration=全场，
      refs=7（combination + 6 companions），**无 render_index/track_render_index**
      （主轨整块段不设，否则剪映判定为浮动组合段→切片+锁定拖不动）。
    - 普通轨段：引用真实素材，refs=6（每段独立一套 companions），
      hdr_settings.mode=1，render_index/track_render_index=轨道索引。
    - materials.videos = 1502 真实 + 1 mc_video（path=""，check_flag=62978047）。
    - config.maintrack_adsorb=false + config.use_float_render=true +
      顶层 render_index_track_mode_on=true（缺 use_float_render/track_mode 时
      剪映会切开主轨组合段导致多机位钉死）。
    - materials.drafts=[combination]（内嵌完整 3 角度 draft），三个路径用
      同一个 ##_draftpath_placeholder_<UUID>_##/subdraft/<sub_id>/ 前缀。
  subdraft/<sub_id>/draft_content.json（明文）：
    - 顶层 1 条 video 轨，segment 引用**同一个 mc_video id** + 7 个 refs
      （combination + 6 顶层 companions），hdr_settings=null。
    - 顶层 materials.videos=[mc_video]（check_flag=62978047）。
    - 顶层 materials.drafts=[combination]（内嵌完整 draft），
      draft_file_path=##_subdraft_placeholder_<UUID>_##/draft_content.json。
    - **内嵌 draft.id = 文件夹名 sub_id**，3 条角度轨（514/508/480 段），
      角度轨 segment 完整 51 字段，source.start=0，target.start=对齐偏移。
    - 内嵌 draft materials.videos = 1502 真实素材（独立 id，check_flag=29931519）。
  subdraft 根目录 + UUID 子目录各一份 draft_content.json + sub_draft_config.json。

关键 id 关系（模板+8月20日参照实证）：
  - 主草稿 mc_video.id == subdraft 顶层 videos[0].id == 顶层 segment.material_id
    == 主草稿多机位主轨 segment.material_id
  - 主草稿 mc_video.check_flag == 顶层 mc_video.check_flag == 62978047
  - cur_camera_track_id = 内嵌 draft 角度轨0 的 track id（主草稿+顶层都指向它）
  - 内嵌 draft 素材 id 与主草稿素材 id 无关（同一文件两个 id，各自注册）

用法：
    python3 build_capcut_draft_31.py
输出：{OUT_DIR}/{PROJ_NAME}_音频同步多机位_capcut_draft/
"""
import os, sys, json, uuid, shutil, time, copy, base64
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config

cfg = get_config()
WORK = cfg.WORK or "/tmp/syncwork"
BASE = cfg.BASE or "/"
FPS = float(cfg.fps)
W, H = cfg.width, cfg.height
CAM_LIST = cfg.cam_list
DAY_DIRS = cfg.day_dirs
PROJ_NAME = (cfg.manual.get("project_name")
             or f"{len(DAY_DIRS)}天合并")
OUT_DIR = cfg.OUT_DIR or "."
DRAFT_NAME = f"{PROJ_NAME}_音频同步多机位_capcut_draft"
DRAFT_PATH = os.path.join(OUT_DIR, DRAFT_NAME)

# 3+1 多机位结构骨架：不再依赖本机某个剪映模板，而是从随脚本分发的
# capcut_draft_schema.json 加载（该文件是 2026-08-21 验证通过的 3+1 模板
# 提取出的纯字段形状 skeleton，见 P0 通用化）。所有 id/路径/时长在生成时
# 都会被覆盖成新项目的值，因此 skeleton 只提供字段结构，不携带任何素材。
SCHEMA = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "capcut_draft_schema.json")

COMP_KEYS = ["speeds", "placeholder_infos", "canvases",
             "sound_channel_mappings", "material_colors",
             "vocal_separations"]

# 最小合法 JPEG（1x1 黑色），用作剪映盒子缩略占位封面。
_PLACEHOLDER_COVER_BYTES = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEB"
    "AxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAAB"
    "AD//2Q==")


def make_uuid():
    return str(uuid.uuid4()).upper()


def sec_to_us(s):
    return int(round(s * 1_000_000))


def load_day(day):
    return pd.read_csv(f"{WORK}/positions_{day}_compressed.tsv", sep="\t")


def load_template():
    """从随脚本分发的 capcut_draft_schema.json 加载 3+1 骨架（纯字段形状）。

    该 schema 由 2026-08-21 验证通过的剪映模板提取，字段结构与实机一致；
    main/sub/inner/meta 各段在此返回后由 build() 覆盖全部 id/路径/时长。
    不再触碰本机任何 ~/Movies/JianyingPro 路径 —— 换机器/换用户可直接用。
    """
    with open(SCHEMA, encoding="utf-8") as f:
        schema = json.load(f)
    main = schema["main"]
    sub = schema["sub"]
    meta = schema["meta"]
    return main, sub, meta


def find_draft_root():
    """动态探测用户剪映/CapCut 草稿根目录（跨 macOS/Windows/Linux）。

    按运行平台依次探测常见位置（glob recursive 覆盖 "User Data/Projects/"
    等多级目录）；找不到时返回 None，由调用方回退到 OUT_DIR 本地放置。
    仅探测**本机**路径，不会碰任何共享 workspace。
    """
    import glob
    home = os.path.expanduser("~")
    cand = []
    if sys.platform == "darwin":
        roots = (
            f"{home}/Movies/JianyingPro",
            f"{home}/Movies/CapCut",
            f"{home}/Documents/JianyingPro",
        )
    elif os.name == "nt":      # Windows
        roots = (
            f"{home}/AppData/Local/JianyingPro",
            f"{home}/AppData/Local/CapCut",
            f"{home}/AppData/Roaming/JianyingPro",
            f"{home}/AppData/Roaming/CapCut",
        )
    else:                       # Linux（CapCut AppImage 等）+ 兜底
        roots = (
            f"{home}/Documents",
            f"{home}/.local/share",
            f"{home}/.config",
            f"{home}/AppData/Local/CapCut",
            f"{home}/AppData/Local/JianyingPro",
        )
    for r in roots:
        cand += glob.glob(f"{r}/**/com.lveditor.draft", recursive=True)
    seen = set()
    out = []
    for c in cand:
        c = os.path.normpath(c)
        if os.path.isdir(c) and c not in seen:
            seen.add(c)
            out.append(c)
    return out[0] if out else None


def build_clips():
    days = [load_day(day) for day, _ in DAY_DIRS]
    spans_us = []
    for d in days:
        spans_us.append(sec_to_us((d.pos + d.dur).max() - d.pos.min()))
    total_us = sum(spans_us)
    clips = []
    shift_us = 0
    for di, (day, dname) in enumerate(DAY_DIRS):
        df = days[di].sort_values(["cam", "pos"]).reset_index(drop=True)
        z = df.pos.min()
        for _, r in df.iterrows():
            name = os.path.splitext(r["file"])[0]
            path = os.path.join(BASE, r["dir"], r["file"])
            abs_start = sec_to_us(r["pos"] - z) + shift_us
            dur = sec_to_us(r["dur"])
            clips.append((r["cam"], abs_start, dur, path, name))
        if di < len(DAY_DIRS) - 1:
            shift_us += spans_us[di]
    return clips, total_us


def build():
    if os.path.isdir(DRAFT_PATH):
        shutil.rmtree(DRAFT_PATH)
    os.makedirs(DRAFT_PATH, exist_ok=True)
    # 清理可能存在的 AppleDouble 残留（._* 会干扰剪映解析子草稿）
    for dp, _, fs in os.walk(DRAFT_PATH):
        for f in fs:
            if f.startswith("._"):
                os.remove(os.path.join(dp, f))
    clips, total_us = build_clips()
    print(f"片段总数: {len(clips)}, 总时长: {total_us/1e6:.1f}s = {total_us/3.6e9:.2f}h")

    tpl_main, tpl_sub, tpl_meta = load_template()
    tpl_inner = tpl_sub["materials"]["drafts"][0]["draft"]

    # ---- id 分配 ----
    sub_id = make_uuid()                      # 文件夹名 = 内嵌 draft id
    comb_id = make_uuid()                     # combination.id（subdraft 顶层）
    comb_inner_id = make_uuid()               # combination.combination_id
    mc_id = make_uuid()                       # mc_video（主草稿+顶层共用）
    mc_mci_id = make_uuid()                   # multi_camera_info.id（两边共用）
    angle_track_ids = [make_uuid() for _ in CAM_LIST]
    cur_track_id = angle_track_ids[0]

    # 真实素材（主草稿注册 1502 + 内嵌注册 1502，id 独立）
    main_mat_ids = {}
    inner_mat_ids = {}
    seen = set()
    for cam, abs_start, dur, path, name in clips:
        if path in seen:
            continue
        seen.add(path)
        main_mat_ids[path] = make_uuid()
        inner_mat_ids[path] = make_uuid()

    # 主草稿每段独立一套 companions：1502 普通段 + 1 多机位段 = 1503 套
    n_main_segs = len(clips) + 1
    main_comp_ids = [{k: make_uuid() for k in COMP_KEYS}
                     for _ in range(n_main_segs)]
    # subdraft 顶层 6 companions
    top_comp_ids = {k: make_uuid() for k in COMP_KEYS}
    # 内嵌 draft 每角度一套 6 companions
    angle_comp_ids = [{k: make_uuid() for k in COMP_KEYS}
                      for _ in CAM_LIST]

    # ================= 主草稿 =================
    main = copy.deepcopy(tpl_main)
    main["id"] = make_uuid()            # 每次生成用新 UUID（通用 skill 不再用机器固定 ID）
    main["name"] = DRAFT_NAME
    main["duration"] = total_us
    # 主轨磁吸开关：必须显式关掉，否则剪映加载会把普通轨之间/片段间的
    # 对齐间隙吸掉（磁吸打开时自动压缩主轨间隙 → 三个机位时间轴错位）。
    # 实证：用户新建的两个对照草稿，磁吸关闭的 config = {"maintrack_adsorb": false}
    # （保留 Fragment 真实间隙），磁吸打开的 config 无此字段（间隙被吸没）。
    main["config"]["maintrack_adsorb"] = False
    # 可移动多机位主轨（8月20日剪映实机参照）额外字段：use_float_render +
    # 顶层 render_index_track_mode_on。缺这两个字段时剪映对主轨组合段做
    # "自动切段+锁定"（导致多机位钉死拖不动）。加这两字段避免剪映切开主轨。
    main["config"]["use_float_render"] = True
    main["render_index_track_mode_on"] = True
    # 混合轨道模式：主轨必须可落普通/新素材（8月20日可移动参照实证）。
    # 缺这三样 → 轨道 type=video 模式，剪映主轨不接受普通素材落上去，
    # 连新素材也拖不进主轨。8月20日 顶层有 mixed_track_mode_on=true +
    # version=360000 + 全轨 type=mixed。生成必须显式带上，否则复现"主轨
    # 无法落素材"。用户 2026-08-21 验证：补这三样后主轨可拖新素材。
    main["mixed_track_mode_on"] = True
    main["version"] = 360000

    # --- 普通轨 segment 模板（轨0 seg0，精简结构）---
    seg_tpl = copy.deepcopy(tpl_main["tracks"][0]["segments"][0])
    # --- 多机位轨 segment（04:43 模板轨3 seg0；用户调整后放主轨 segments 结构不变）---
    mc_seg_tpl = copy.deepcopy(tpl_main["tracks"][3]["segments"][0])

    tracks = []
    comp_idx = 0
    # ---- 多机位轨放主轨（tracks[0]）----
    # 用户 2026-08-21 在剪映里手动调整后的最终形态：多机位放主轨（索引0），
    # 3 条普通轨放它之上（索引1/2/3）。剪映加载已正确识别（把多机位挪到主轨）。
    # config.maintrack_adsorb 仍显式写 false（保险：确保普通轨间隙不被压缩）。
    ms = copy.deepcopy(mc_seg_tpl)
    ms["id"] = make_uuid()
    ms["material_id"] = mc_id
    ms["source_timerange"] = {"duration": total_us}
    ms["target_timerange"] = {"duration": total_us}
    # 主轨整块段必须剥离模板段自带的 render_index/track_render_index
    # （mc_seg_tpl 来自模板 track3 seg0，带 render_index=3）。8月20日可移动参照
    # 里主轨 MC 段无这两个字段；保留会被剪映当浮动组合段→切片+锁定拖不动。
    ms.pop("render_index", None)
    ms.pop("track_render_index", None)
    # 7 refs：drafts(combination) + 6 companions —— 1-track 成功版实证：
    # 多机位轨 segment 必须引用 combination(drafts) 才能关联子草稿，
    # 否则剪映打开时找不到子草稿 → 媒体丢失
    ms["extra_material_refs"] = [comb_id] + [main_comp_ids[comp_idx][k]
                                             for k in COMP_KEYS]
    # 主轨段不设 render_index/track_render_index —— 对齐 8月20日 可移动参照：
    # 主轨整块 MC 段这两个字段都是 None。设了 render_index=0 会被剪映当
    # "普通浮动轨组合段"处理 → 自动切片 + 锁定（拖不动，用户实测反馈）。
    tracks.append({
        "id": make_uuid(),
        "type": "mixed",
        "is_default_name": True,
        "segments": [ms],
    })
    comp_idx += 1
    print(f"  多机位轨（主轨）: 1 段")

    # ---- 3 条普通轨 A/B/C 放主轨之上（tracks[1/2/3]）----
    for ai, cam in enumerate(CAM_LIST):
        cam_clips = sorted([c for c in clips if c[0] == cam],
                           key=lambda c: c[1])
        segs = []
        for cam_, abs_start, dur, path, name in cam_clips:
            s = copy.deepcopy(seg_tpl)
            s["id"] = make_uuid()
            s["material_id"] = main_mat_ids[path]
            s["source_timerange"] = {"duration": dur}
            s["target_timerange"] = {"duration": dur, "start": abs_start}
            s["extra_material_refs"] = [main_comp_ids[comp_idx][k]
                                        for k in COMP_KEYS]
            segs.append(s)
            comp_idx += 1
        tr = {
            "id": make_uuid(),
            "type": "mixed",
            "flag": 2,
            "is_default_name": True,
            "segments": segs,
        }
        tracks.append(tr)
        print(f"  普通轨{cam}: {len(segs)} 段")

    main["tracks"] = tracks

    # --- materials.videos：1502 真实 + 1 mc ---
    main_videos = []
    for path in main_mat_ids:
        name = os.path.splitext(os.path.basename(path))[0]
        dur = next(c[2] for c in clips if c[3] == path)
        v = copy.deepcopy(tpl_main["materials"]["videos"][0])
        v["id"] = main_mat_ids[path]
        v["path"] = path
        v["material_name"] = name
        v["duration"] = int(dur)
        v["width"], v["height"] = W, H
        main_videos.append(v)
    # mc_video（模板里的多机位素材对象）
    mc_tpl = [v for v in tpl_main["materials"]["videos"]
              if v.get("multi_camera_info")][0]
    mc_v = copy.deepcopy(mc_tpl)
    mc_v["id"] = mc_id
    mc_v["duration"] = int(total_us)
    mc_v["material_name"] = f"{PROJ_NAME}｜多机位片段"
    # check_flag 对齐可移动参考(8月20日主稿 MC=62978047，与 sub 顶层 MC 一致)。
    # 模板 04:43 主稿 MC 是 63502335（那条多机位在独立轨 track3）；当多机位放
    # 主轨时须用 62978047，否则剪映判定为"可切开的浮动组合段"→ 切片 + 锁定。
    mc_v["check_flag"] = 62978047
    mc_v["multi_camera_info"] = {
        "id": mc_mci_id,
        "cur_camera_track_id": cur_track_id,
        "audio_open_track_id_list": [cur_track_id],
    }
    main_videos.append(mc_v)
    main["materials"]["videos"] = main_videos
    print(f"主草稿 videos: {len(main_videos)} (1502 真实 + 1 mc)")

    # --- companions：每段一套（1503 套）---
    # schema 里 companion 数组各 trim 到 2 个占位；它们只是"一份能带 id 的字段
    # 形状"，生成时全部以 [0] 为模板并覆写 id（无 per-index 字段）。
    for k in COMP_KEYS:
        arr = []
        for i in range(n_main_segs):
            t = copy.deepcopy(tpl_main["materials"][k][0])
            t["id"] = main_comp_ids[i][k]
            arr.append(t)
        main["materials"][k] = arr

    # 主草稿 drafts 在 combination 构造后统一填写（见下方 mcomb）

    # ================= subdraft =================
    top = copy.deepcopy(tpl_sub)
    top["id"] = make_uuid()                # 独立 UUID（≠ 文件夹名）
    top["name"] = DRAFT_NAME
    top["duration"] = total_us

    tseg = top["tracks"][0]["segments"][0]
    tseg["id"] = make_uuid()
    tseg["material_id"] = mc_id
    tseg["source_timerange"] = {"start": 0, "duration": float(total_us)}
    tseg["target_timerange"] = {"start": 0, "duration": float(total_us)}
    tseg["hdr_settings"] = None
    tseg["extra_material_refs"] = ([comb_id] +
                                   [top_comp_ids[k] for k in COMP_KEYS])
    top["tracks"][0]["segments"] = [tseg]

    tmv = top["materials"]["videos"][0]
    tmv["id"] = mc_id
    tmv["duration"] = int(total_us)
    tmv["material_name"] = f"{PROJ_NAME}｜多机位片段"
    tmv["multi_camera_info"] = {
        "audio_open_track_id_list": [cur_track_id],
        "cur_camera_track_id": cur_track_id,
        "id": mc_mci_id,
        "pre_compile_to_normal_video": False,
    }
    top["materials"]["videos"] = [tmv]

    # --- 内嵌 draft：3 角度轨 ---
    inner = copy.deepcopy(tpl_inner)
    inner["id"] = sub_id
    inner["name"] = f"{PROJ_NAME}｜多机位片段"
    inner["duration"] = int(total_us)

    angle_seg_tpl = copy.deepcopy(tpl_inner["tracks"][0]["segments"][0])
    angle_tracks = []
    for ai, cam in enumerate(CAM_LIST):
        cam_clips = sorted([c for c in clips if c[0] == cam],
                           key=lambda c: c[1])
        segs = []
        for cam_, abs_start, dur, path, name in cam_clips:
            s = copy.deepcopy(angle_seg_tpl)
            s["id"] = make_uuid()
            s["material_id"] = inner_mat_ids[path]
            s["source_timerange"] = {"start": 0, "duration": float(dur)}
            s["target_timerange"] = {"start": float(abs_start),
                                     "duration": float(dur)}
            s["extra_material_refs"] = [angle_comp_ids[ai][k]
                                        for k in COMP_KEYS]
            segs.append(s)
        angle_tracks.append({
            "attribute": 0, "flag": 0, "id": angle_track_ids[ai],
            "is_default_name": True, "name": "", "segments": segs,
            "type": "video",
        })
        print(f"  内嵌角度{cam}: {len(segs)} 段")
    inner["tracks"] = angle_tracks

    # 内嵌真实素材（独立 id）
    inner_videos = []
    for path in inner_mat_ids:
        name = os.path.splitext(os.path.basename(path))[0]
        dur = next(c[2] for c in clips if c[3] == path)
        v = copy.deepcopy(tpl_inner["materials"]["videos"][0])
        v["id"] = inner_mat_ids[path]
        v["path"] = path
        v["material_name"] = name
        v["duration"] = float(dur)
        v["width"], v["height"] = W, H
        inner_videos.append(v)
    inner["materials"]["videos"] = inner_videos

    # 内嵌 companions：每角度 1 套（以 [0] 为模板覆写 id，同主草稿）
    for k in COMP_KEYS:
        arr = []
        for ai in range(len(CAM_LIST)):
            t = copy.deepcopy(tpl_inner["materials"][k][0])
            t["id"] = angle_comp_ids[ai][k]
            arr.append(t)
        inner["materials"][k] = arr

    # --- combination（subdraft 顶层 + 主草稿 drafts 双份）---
    comb = top["materials"]["drafts"][0]
    comb["id"] = comb_id
    comb["combination_id"] = comb_inner_id
    comb["name"] = f"{PROJ_NAME}｜多机位片段"
    comb["draft"] = inner
    # subdraft 顶层组合的路径（04:43 模板实证：三个路径用同一个
    # ##_subdraft_placeholder_<UUID>_## 占位符）
    ph = f"##_subdraft_placeholder_{make_uuid()}_##"
    comb["draft_config_path"] = f"{ph}/sub_draft_config.json"
    comb["draft_cover_path"] = f"{ph}/draft_cover.jpg"
    comb["draft_file_path"] = f"{ph}/draft_content.json"
    top["materials"]["drafts"] = [comb]

    # 主草稿 drafts：1-track 成功版（14:07 剪映保存）实证——主草稿
    # materials.drafts=[combination] 内嵌完整 draft，三个路径用同一个
    # ##_draftpath_placeholder_<UUID>_## 占位符 + subdraft/<sub_id>/ 子路径。
    # 多机位轨 segment 的 refs[0] 引用它 → 剪映才能关联子草稿渲染多机位。
    mph = f"##_draftpath_placeholder_{make_uuid()}_##"
    mcomb = {
        "id": comb_id,
        "type": "combination",
        "name": f"{PROJ_NAME}｜多机位片段",
        "combination_id": comb_inner_id,
        "combination_type": "none",
        "draft": inner,
        "draft_config_path": f"{mph}/subdraft/{sub_id}/sub_draft_config.json",
        "draft_cover_path": f"{mph}/subdraft/{sub_id}/draft_cover.jpg",
        "draft_file_path": f"{mph}/subdraft/{sub_id}/draft_content.json",
    }
    main["materials"]["drafts"] = [mcomb]

    # 顶层 6 companions
    for k in COMP_KEYS:
        arr = top["materials"][k]
        arr[0]["id"] = top_comp_ids[k]
        top["materials"][k] = [arr[0]]

    # ================= 写文件 =================
    sub_dir = os.path.join(DRAFT_PATH, "subdraft", sub_id)
    os.makedirs(sub_dir, exist_ok=True)
    subdraft_root = os.path.join(DRAFT_PATH, "subdraft")

    with open(os.path.join(DRAFT_PATH, "draft_info.json"),
              "w", encoding="utf-8") as f:
        json.dump(main, f, ensure_ascii=False, separators=(",", ":"))
    # 子草稿内容：subdraft 根目录一份 + UUID 子目录一份（剪映按根目录
    # sub_draft_config.json 解析多机位素材——实证：剪映重写版 meta type18
    # 第二条 file_Path="./subdraft/sub_draft_config.json"，媒体丢失即因此）
    with open(os.path.join(subdraft_root, "draft_content.json"),
              "w", encoding="utf-8") as f:
        json.dump(top, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(sub_dir, "draft_content.json"),
              "w", encoding="utf-8") as f:
        json.dump(top, f, ensure_ascii=False, separators=(",", ":"))

    now_s = int(time.time())
    sub_cfg = {
        "audio_path": "", "cover_height": 320,
        "cover_path": "draft_cover.jpg", "cover_width": 180,
        "create_time": now_s,
        "draft_json_file": "draft_content.json",
        "id": sub_id,
        "import_time_ms": now_s * 1000,
        "is_from_multi_timeline": False, "is_from_sub_draft": True,
        "material_color_tag": "",
        "name": f"{PROJ_NAME}｜多机位片段",
        "project_id": sub_id,
        "rough_cut_duration": int(total_us), "rough_cut_start": 0,
        "source": "timeline", "type": "video",
    }
    with open(os.path.join(sub_dir, "sub_draft_config.json"),
              "w", encoding="utf-8") as f:
        json.dump(sub_cfg, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(subdraft_root, "sub_draft_config.json"),
              "w", encoding="utf-8") as f:
        json.dump(sub_cfg, f, ensure_ascii=False, separators=(",", ":"))

    # meta：以 schema 内 meta 为基底（全字段）+ 覆盖标识/路径/时长 + 注册素材。
    # draft_root_path 动态探测用户剪映草稿根目录（不写死机器路径）；找不
    # 到时回退为 DRAFT_PATH 自身（本地直接打开入口也成立）。
    meta = copy.deepcopy(tpl_meta)
    meta["draft_id"] = main["id"]
    meta["draft_name"] = DRAFT_NAME
    draft_root = find_draft_root()
    if draft_root:
        meta["draft_root_path"] = draft_root
        meta["draft_fold_path"] = os.path.join(draft_root, DRAFT_NAME)
    else:
        meta["draft_root_path"] = os.path.dirname(DRAFT_PATH)
        meta["draft_fold_path"] = DRAFT_PATH
    meta["tm_duration"] = int(total_us)
    meta["tm_draft_create"] = now_s * 1_000_000
    meta["tm_draft_modified"] = now_s * 1_000_000
    mat_meta = []
    for path in main_mat_ids:
        name = os.path.splitext(os.path.basename(path))[0]
        dur = next(c[2] for c in clips if c[3] == path)
        mat_meta.append({
            "ai_group_type": "", "create_time": 0,
            "duration": dur, "enter_from": 0,
            "extra_info": name, "file_Path": path,
            "height": H, "id": make_uuid(),
            "import_time": now_s, "import_time_ms": -1,
            "item_source": 1, "material_color_tag": "", "md5": "",
            "metetype": "video",
            "roughcut_time_range": {"duration": dur, "start": 0},
            "sub_time_range": {"duration": -1, "start": -1},
            "type": 0, "width": W,
        })
    comb_meta = {
        "ai_group_type": "", "create_time": now_s,
        "duration": int(total_us), "enter_from": 0,
        "extra_info": f"{PROJ_NAME}｜多机位片段",
        # 指向 subdraft 根目录（剪映重写版实证：meta type18 第二条
        # file_Path="./subdraft/sub_draft_config.json"，按根目录解析）
        "file_Path": "./subdraft/sub_draft_config.json",
        "height": 0, "id": make_uuid(),
        "import_time": now_s, "import_time_ms": now_s * 1000,
        "item_source": 1, "material_color_tag": "", "md5": "",
        "metetype": "combination",
        "roughcut_time_range": {"duration": int(total_us), "start": 0},
        "sub_time_range": {"duration": -1, "start": -1},
        "type": 18, "width": 0,
    }
    dm = [{"type": 0, "value": mat_meta}]
    for t in [1, 2, 3, 6, 7, 8]:
        dm.append({"type": t, "value": []})
    dm.append({"type": 18, "value": [comb_meta]})
    meta["draft_materials"] = dm
    with open(os.path.join(DRAFT_PATH, "draft_meta_info.json"),
              "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))

    # 辅助文件
    with open(os.path.join(DRAFT_PATH, "draft_agency_config.json"),
              "w", encoding="utf-8") as f:
        f.write("{}")
    with open(os.path.join(DRAFT_PATH, "performance_opt_info.json"),
              "w", encoding="utf-8") as f:
        f.write('{"manual_cancle_precombine_segs":null,'
                '"need_auto_precombine_segs":null}')
    with open(os.path.join(DRAFT_PATH, "draft_settings"),
              "w", encoding="utf-8") as f:
        f.write(f"[General]\ncloud_last_modify_platform=mac\n"
                f"draft_create_time={now_s}\n"
                f"draft_last_edit_time={now_s}\nreal_edit_keys=1\n"
                f"real_edit_seconds=0\n")
    # 封面：模板不再随脚本分发（P0 通用化去掉本机模板依赖），这里的
    # draft_cover.jpg 只是剪映侧盒子的缩略占位（非功能性），写一个最小
    # 合法 JPEG 即可。素材图片不宜打进 JSON schema，故内联生成占位图。
    cover = _PLACEHOLDER_COVER_BYTES
    for dst in (os.path.join(DRAFT_PATH, "draft_cover.jpg"),
                os.path.join(sub_dir, "draft_cover.jpg")):
        with open(dst, "wb") as f:
            f.write(cover)

    # 最后清理：外置盘(PSSD)上 macOS 会为每个写入文件生成 ._* AppleDouble，
    # 剪映解析子草稿会被这些文件干扰，rsync 排除无效（生成时就产生了）
    for dp, _, fs in os.walk(DRAFT_PATH):
        for f in fs:
            if f.startswith("._"):
                os.remove(os.path.join(dp, f))

    print(f"\n已生成 3+1 草稿: {DRAFT_PATH}")
    print(f"  subdraft: {sub_id}")
    print(f"  combination: {comb_id}")
    print(f"  cur_camera_track_id: {cur_track_id}")
    return DRAFT_PATH


if __name__ == "__main__":
    build()
