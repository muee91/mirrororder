#!/usr/bin/env python3
"""Validate a generated Jianying/CapCut native 3+1 multicam draft (P0 回归保护).

对 build_capcut_draft_31.py 生成的草稿做结构性不变量断言，全部通过打印
统计并 exit 0，任一失败打印 FAIL 并 exit 1。兼顾：
  - 字段形状参考来自 capcut_draft_schema.json（但 id/路径/时长每次不同，
    校验只关注不变量，不比对具体值）。
  - 跨平台：只读一个草稿目录，不依赖任何 OS 特定路径。
  - 两种模式（2026-08-24 扩展，承接 8月20日 剪映已保存草稿实测 11 项 FAIL）：
      * raw（默认）：build_capcut_draft_31.py 的**单一组合原始产物**，全部判据从严。
      * saved：剪映加载并保存后的草稿（组合可能被拆成多个 subdraft、内嵌角度轨数
        与 id、meta、type18、source.start 会被剪映重写），只锁**跨结构不变量**，
        放宽被剪映重写的结构字段。

用法：
    python3 validate_capcut_draft.py <draft_dir> [--mode=raw|saved|auto]
    # --mode 默认 auto：subdraft 恰 1 个 UUID 子目录 → raw，否则 saved。
    # 省略 draft_dir：用 config.json 的 OUT_DIR + 项目名拼出草稿目录。
"""
import os, sys, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from project_config import get_config

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "capcut_draft_schema.json")

MODE = "auto"  # 由 main() 解析/推导，全局供各 validate_* 分段判定

COMP_KEYS = ["speeds", "placeholder_infos", "canvases",
             "sound_channel_mappings", "material_colors",
             "vocal_separations"]

NOTES, ERRORS = [], []


def ok(cond, msg):
    (NOTES if cond else ERRORS).append(("ok  " if cond else "FAIL ") + msg)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def all_material_ids(materials):
    """收集 materials 下所有带 id 的对象（含内嵌 draft 里的）。"""
    ids = set()
    if not isinstance(materials, dict):
        return ids
    def walk(o):
        if isinstance(o, dict):
            if "id" in o:
                ids.add(o["id"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for it in o:
                walk(it)
    walk(materials)
    return ids


def find_mc_video(materials):
    """返回 videos 里的多机位素材（path 为空 + 带 multi_camera_info）。"""
    for v in materials.get("videos", []):
        if v.get("path") == "" and v.get("multi_camera_info"):
            return v
    return None


def count_real_videos(materials):
    return sum(1 for v in materials.get("videos", []) if v.get("path"))


def validate_main(main):
    # 顶层开关
    ok(isinstance(main, dict), "draft_info.json 顶层是对象")

    ok(main.get("render_index_track_mode_on") is True,
       "顶层 render_index_track_mode_on=true")
    ok(main.get("mixed_track_mode_on") is True, "顶层 mixed_track_mode_on=true")
    ok(main.get("version") == 360000, "顶层 version=360000")
    ok(main.get("config", {}).get("maintrack_adsorb") is False,
       "config.maintrack_adsorb=false")
    ok(main.get("config", {}).get("use_float_render") is True,
       "config.use_float_render=true")

    tracks = main.get("tracks", [])
    ok(len(tracks) == 4, f"主草稿 4 轨（= {len(tracks)}）")

    materials = main.get("materials", {})
    mat_ids = all_material_ids(materials)
    mc = find_mc_video(materials)
    ok(mc is not None, "materials.videos 含多机位 mc_video")
    drafts = materials.get("drafts", [])

    if tracks and mc is not None and drafts:
        t0 = tracks[0]
        segs = t0.get("segments", [])
        ok(len(segs) == 1, "多机位主轨(track0) 只有 1 段")
        if segs:
            s = segs[0]
            ok(s.get("material_id") == mc["id"],
               "主轨段 material_id = mc_video.id")
            refs = s.get("extra_material_refs", [])
            ok(len(refs) == 7, f"主轨段 7 refs（combination+6 compan= {len(refs)}）")
            ok(drafts and refs and refs[0] == drafts[0]["id"],
               "主轨段 refs[0] = combination.id")
            bad = [r for r in refs if r not in mat_ids]
            ok(not bad, "主轨段 refs 全部可解析到 materials")
            # 主轨整块段必须剥离 render_index/track_render_index（否则剪映
            # 判定为浮动组合段 → 切片+锁定拖不动）
            ok("render_index" not in s and "track_render_index" not in s,
               "主轨段无 render_index/track_render_index")

    # 普通轨：material_id 在真实素材中，refs 可解析
    # raw: 每段恰 6 refs；saved: 剪映重排后普通轨内可能混入多机位段（7 refs）
    for i in range(1, len(tracks)):
        for s in tracks[i].get("segments", []):
            ok(s.get("material_id") in mat_ids,
               f"普通轨 track{i} 段 material_id 可解析")
            refs = s.get("extra_material_refs", [])
            if MODE == "raw":
                ok(len(refs) == 6, f"普通轨 track{i} 段 6 refs（={len(refs)}）")
            else:
                ok(len(refs) in (6, 7),
                   f"普通轨 track{i} 段 {len(refs)} refs（6=普通/7=混入多机位）")
            bad = [r for r in refs if r not in mat_ids]
            ok(not bad, f"普通轨 track{i} 段 refs 全部可解析")

    if mc is not None:
        ok(mc.get("check_flag") == 62978047,
           f"主稿 mc_video.check_flag=62978047（={mc.get('check_flag')}）")
    ok(count_real_videos(materials) >= 1,
       f"主稿真实素材 {count_real_videos(materials)} 个")

    if drafts:
        d = drafts[0]
        ok("draft" in d and isinstance(d["draft"], dict),
           "主稿 drafts[0] 内嵌完整 draft")
        for key in ("draft_config_path", "draft_cover_path", "draft_file_path"):
            p = d.get(key, "")
            ok("##_draftpath_placeholder_" in p and "/subdraft/" in p,
               f"主稿 drafts[0].{key} 用 draftpath 占位符 + subdraft 路径")
    return mc


def validate_sub(top, sub_id):
    ok(isinstance(top, dict), "subdraft/draft_content.json 顶层是对象")

    materials = top.get("materials", {})
    mat_ids = all_material_ids(materials)
    mc = find_mc_video(materials)
    ok(mc is not None, "sub 顶层 videos 含 mc_video")
    drafts = materials.get("drafts", [])

    tts = top.get("tracks", [])
    ok(len(tts) == 1, "sub 顶层 1 条 video 轨")
    if tts:
        segs = tts[0].get("segments", [])
        ok(len(segs) == 1, "sub 顶层轨 1 段")
        if segs and mc is not None:
            s = segs[0]
            ok(s.get("material_id") == mc["id"],
               "sub 顶层段 material_id = mc_video.id")
            ok(s.get("hdr_settings") is None, "sub 顶层段 hdr_settings=null")
            refs = s.get("extra_material_refs", [])
            ok(len(refs) == 7, f"sub 顶层段 7 refs（={len(refs)}）")
            ok(drafts and refs and refs[0] == drafts[0]["id"],
               "sub 顶层段 refs[0] = combination.id")
            bad = [r for r in refs if r not in mat_ids]
            ok(not bad, "sub 顶层段 refs 全部可解析")

    if mc is not None:
        ok(mc.get("check_flag") == 62978047,
           f"sub 顶层 mc_video.check_flag=62978047（={mc.get('check_flag')}）")

    # 内嵌 draft
    # raw: 恰 1 个 combination；saved: 剪映重排后只要求存在（组合可被拆/合并，
    #      drafts 数量与 id 可能被剪映重写）——只锁"有内嵌组合"这一跨结构不变量
    if MODE == "raw":
        ok(len(drafts) == 1, "sub 顶层 1 个 combination")
    else:
        ok(len(drafts) >= 1, f"sub 顶层 combination 存在（={len(drafts)}）")
    if drafts and "draft" in drafts[0]:
        inner = drafts[0]["draft"]
        if MODE == "raw":
            ok(inner.get("id") == sub_id,
               f"内嵌 draft.id = 文件夹名 sub_id（={inner.get('id')}/{sub_id}）")
        itracks = inner.get("tracks", [])
        if MODE == "raw":
            ok(len(itracks) == 3, f"内嵌 draft 3 条角度轨（={len(itracks)}）")
        else:
            ok(len(itracks) >= 1,
               f"内嵌 draft 角度轨存在（={len(itracks)} 条）")
        ipath = drafts[0].get("draft_file_path", "")
        ok("##_subdraft_placeholder_" in ipath,
           f"sub 顶层 combination.draft_file_path 用 subdraft 占位符（={ipath!r}）")
        imat = inner.get("materials", {})
        imc_ids = all_material_ids(imat)
        for ti, tr in enumerate(itracks):
            for s in tr.get("segments", []):
                ok(s.get("material_id") in imc_ids,
                   f"角度轨 track{ti} 段 material_id 可解析")
                if MODE == "raw":
                    ok(s.get("source_timerange", {}).get("start") == 0,
                       "角度轨段 source.start=0")
                ok("start" in s.get("target_timerange", {}),
                   "角度轨段 target_timerange 含 start（对齐偏移）")
                refs = s.get("extra_material_refs", [])
                if MODE == "raw":
                    ok(len(refs) == 6, f"角度轨 track{ti} 段 6 refs（={len(refs)}）")
                else:
                    ok(len(refs) in (6, 7),
                       f"角度轨 track{ti} 段 {len(refs)} refs（6=普通/7=混入多机位）")
                bad = [r for r in refs if r not in imc_ids]
                ok(not bad, f"角度轨 track{ti} 段 refs 全部可解析")
        ok(count_real_videos(imat) >= 1,
           f"内嵌 draft 真实素材 {count_real_videos(imat)} 个")
    return mc


def validate_meta(meta, main):
    # raw: meta 由 build 脚本生成，draft_id/name 与 main 严格一致。
    # saved: 剪映保存会重写 meta 的 id/name，故只验证 meta 自身形状健全，
    #       不强行要求等于 main 的 id/name（跨结构不变量不包含这层）。
    mid, mname = main.get("id"), main.get("name")
    if MODE == "raw":
        ok(meta.get("draft_id") == mid, "draft_meta_info.draft_id = main.id")
        ok(meta.get("draft_name") == mname, "draft_meta_info.draft_name = main.name")
    else:
        ok(isinstance(meta.get("draft_id"), str) and len(meta["draft_id"]) > 0,
           "draft_meta_info.draft_id 存在（saved 允许被重写）")
        ok(isinstance(meta.get("draft_name"), str) and len(meta["draft_name"]) > 0,
           "draft_meta_info.draft_name 存在（saved 允许被重写）")
    dm = {d.get("type"): d.get("value", []) for d in meta.get("draft_materials", [])}
    ok(dm.get(0), "draft_materials type0 = 真实素材注册")
    ok(0 not in dm or all(isinstance(x, dict) and x.get("file_Path")
                          for x in dm[0]),
       "type0 素材全部带 file_Path")
    comb = dm.get(18, [])
    if comb:
        fp = comb[0].get("file_Path", "")
        if MODE == "raw":
            ok(fp == "./subdraft/sub_draft_config.json",
               f"draft_materials type18 指向根 sub_draft_config.json（={fp!r}）")
        else:
            ok(fp.endswith("sub_draft_config.json"),
               f"draft_materials type18 指向某 sub_draft_config.json（={fp!r}）")
    else:
        # saved: 剪映可能合并/清除 type18；不因缺失而判死
        ok(MODE == "saved", "draft_materials type18 存在（raw 必须有）")


def validate_layout(draft_path, sub_id):
    required = ("draft_info.json", "draft_meta_info.json",
                "draft_agency_config.json", "performance_opt_info.json",
                "draft_settings", "draft_cover.jpg")
    for name in required:
        ok(os.path.isfile(os.path.join(draft_path, name)),
           f"文件存在: {name}")
    sub_root = os.path.join(draft_path, "subdraft")
    sub_dir = os.path.join(sub_root, sub_id)
    ok(os.path.isfile(os.path.join(sub_root, "draft_content.json")),
       "subdraft/draft_content.json")
    ok(os.path.isfile(os.path.join(sub_root, "sub_draft_config.json")),
       "subdraft/sub_draft_config.json")
    ok(os.path.isfile(os.path.join(sub_dir, "draft_content.json")),
       "subdraft/<sub_id>/draft_content.json")
    ok(os.path.isfile(os.path.join(sub_dir, "sub_draft_config.json")),
       "subdraft/<sub_id>/sub_draft_config.json")
    scfg = load_json(os.path.join(sub_dir, "sub_draft_config.json"))
    ok(scfg.get("id") == sub_id, f"sub_draft_config.id = sub_id（={scfg.get('id')}）")


def parse_mode(argv, sub_counts):
    """解析 --mode=raw|saved|auto（auto：按 subdraft 子目录数推导）。
    返回 (mode, positional_path)。"""
    global MODE
    positional = None
    explicit = "auto"
    for arg in argv:
        if arg.startswith("--mode="):
            explicit = arg.split("=", 1)[1].strip().lower()
        else:
            positional = arg
    if explicit not in ("raw", "saved", "auto"):
        print(f"非法 --mode={explicit}（应 raw|saved|auto）")
        sys.exit(2)
    if explicit == "auto":
        MODE = "raw" if sub_counts == 1 else "saved"
    else:
        MODE = explicit
    return MODE, positional


def main():
    args = sys.argv[1:]

    # 先按子目录数推导 auto，才能决定 raw 下"恰 1 个 UUID"是硬判据还是软判据；
    # 但 draft 目录要先用（显式或推导）路径定位。分两步：先取位置参数路径，
    # 再定位 subdraft 子目录数，最后统一解析 mode。
    positional = next((a for a in args if not a.startswith("--mode=")), None)
    if positional:
        draft_path = os.path.abspath(positional)
    else:
        cfg = get_config()
        proj = (cfg.manual.get("project_name")
                or f"{len(cfg.day_dirs)}天合并")
        draft_path = os.path.join(
            cfg.OUT_DIR or ".",
            f"{proj}_音频同步多机位_capcut_draft")

    ok(os.path.isdir(draft_path), f"草稿目录存在: {draft_path}")
    if not os.path.isdir(draft_path):
        print("\n".join(ERRORS))
        sys.exit(1)

    # sub_id = subdraft 下唯一 UUID 子目录
    sub_root = os.path.join(draft_path, "subdraft")
    subs = [n for n in os.listdir(sub_root)
            if os.path.isdir(os.path.join(sub_root, n))]

    mode, _ = parse_mode(args, len(subs))
    if mode == "raw":
        ok(len(subs) == 1, f"subdraft 恰 1 个 UUID 子目录（= {len(subs)}）")
    else:
        ok(len(subs) >= 1, f"subdraft 子目录存在（= {len(subs)}）")
    sub_id = subs[0] if subs else None

    main = load_json(os.path.join(draft_path, "draft_info.json"))
    validate_main(main)
    if sub_id:
        top = load_json(os.path.join(sub_root, "draft_content.json"))
        validate_sub(top, sub_id)
        validate_layout(draft_path, sub_id)
    meta = load_json(os.path.join(draft_path, "draft_meta_info.json"))
    validate_meta(meta, main)

    print(f"草稿: {draft_path}")
    print(f"  sub_id: {sub_id}, 主稿真实素材: "
          f"{count_real_videos(main.get('materials', {}))} + 1 mc")
    print("-" * 60)
    print("\n".join(NOTES))
    print("-" * 60)
    if ERRORS:
        print("失败项:\n" + "\n".join(ERRORS))
        sys.exit(1)
    print(f"通过：{len(NOTES)} 项不变量全部成立。")
    sys.exit(0)


if __name__ == "__main__":
    main()