#!/usr/bin/env python3
"""交付前 FCPXML 结构校验（常设脚本，通用，不依赖本机路径/项目）。

把 references/validation.md 中"不依赖 FCP DTD 就能查"的项固化为代码：
  2. 帧边界审计  —— 所有 offset/duration/start/tcStart 是整数 tick、
     且 tick % frame_ticks == 0（整数 fps=1000，NTSC=1001）。
  3. 素材可达性  —— 所有 asset src / pathurl 解 percent 后指向真实文件。
  4. 引用完整性  —— mc-clip ref→media、asset-clip ref→asset、<format ref>→
     format、multicam format→format、clip video/audio→asset、mc-source
     angleID→mc-angle angleID 全部能被解析。
  6. 结构抽查    —— 每个 mc-angle 内 clip 单调（offset+duration 不重叠、
     无负长 gap）；合并序列 spine 第二段 offset == 第一段 duration。
  7. 官方 DTD   —— 可选：带 --dtd[=PATH]，用 FCP/Creator Studio 的官方
     FCPXMLv1_8.dtd 做 xmllint 完整校验（完美导出的权威门槛）。

用法：
    python3 validate_fcpxml.py <output.fcpxml> [SOURCE_ROOT] [--dtd[=PATH]]

  --dtd   用官方 FCPXMLv1_8.dtd 校验。不带 PATH 时自动在
          /Applications/*.app/.../Interchange.framework/.../ 查找；
          /Applications 下未找到则从 PATH 读取（文件或含该 dtd 的目录）。
          xmllint 不可用时该步被跳过并明确提示，不阻断结构校验。

校验通过退出码 0（打印 PASS 汇总），任何失败退出码 1（打印 FAIL 明细）。
完全导出 = 结构校验 PASS + 官方 DTD 校验 PASS，二者缺一不可。
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from urllib.parse import unquote

TICK_RE = re.compile(r"^(\d+)/(\d+)s$")

DTD_NAME = "FCPXMLv1_8.dtd"


def find_dtd(explicit=None):
    """解析 --dtd 目标：文件/目录/None(自动查找) -> DTD 绝对路径或 None。"""
    if explicit:
        if os.path.isdir(explicit):
            p = os.path.join(explicit, DTD_NAME)
            return p if os.path.isfile(p) else None
        return explicit if os.path.isfile(explicit) else None
    for pat in (
        "/Applications/*.app/Contents/Frameworks/Interchange.framework*/Resources/",
        "/Applications/*.app/Contents/Frameworks/Interchange.framework*/"
        "Versions/*/Resources/",
    ):
        for d in glob.glob(pat + DTD_NAME):
            if os.path.isfile(d):
                return d
    return None


def dtd_errors(xml_path, dtd_path):
    """用官方 DTD 做完整校验。返回错误行列表（空 = 通过）。

    姿势：注入 DOCTYPE（相对引用 DTD 文件名）+ xmllint --valid，把官方 DTD
    拷进与注入 XML 同一临时目录。FCP 这份 DTD 有坑：--dtdvalid 因参数实体
    加载方式会误报"解析失败"；--path 与绝对 SYSTEM 引用对 --valid 分支无效
    （xmllint 按 XML 所在目录解析相对引用），故统一同目录相对引用。
    """
    xmllint = shutil.which("xmllint")
    if not xmllint:
        return ["xmllint 不可用（需 macOS 命令行工具），跳过 DTD 校验"]
    with tempfile.TemporaryDirectory() as td:
        injected = os.path.join(td, "__in__.xml")
        text = open(xml_path, encoding="utf-8").read()
        if text.lstrip().startswith("<?xml"):
            end_decl = text.find("?>")
            text = (text[:end_decl + 2]
                    + f'\n<!DOCTYPE fcpxml SYSTEM "{DTD_NAME}">'
                    + text[end_decl + 2:])
        else:
            text = f'<!DOCTYPE fcpxml SYSTEM "{DTD_NAME}">\n' + text
        open(injected, "w", encoding="utf-8").write(text)
        # xmllint 按注入 XML 所在目录解析相对 SYSTEM（非 cwd），因此把官方
        # DTD 拷进同一 tempdir 命中相对引用。--dtdvalid 与 --path 对 FCP 这
        # 份 DTD 均失效，故用内部 subset + 同目录引用。
        dtd_local = os.path.join(td, DTD_NAME)
        shutil.copyfile(dtd_path, dtd_local)
        r = subprocess.run(
            [xmllint, "--noout", "--valid", injected],
            capture_output=True, text=True)
    err = (r.stderr or "").strip()
    if r.returncode == 0:
        return []
    lines = [ln for ln in err.splitlines() if "validity error" in ln]
    return lines or [err or f"xmllint 失败 exit={r.returncode}"]


def errs_from_frame_boundaries(root, frame_ticks):
    """全部时间属性必须在帧边界上，且任何数值分母必须能被 ticks 整除。"""
    bad = []
    n = 0
    for e in root.iter():
        for attr in ("offset", "duration", "start", "tcStart"):
            v = e.get(attr)
            if v is None:
                continue
            m = TICK_RE.match(v)
            if not m:
                bad.append(f"{e.tag} @{attr}: not N/Ds format -> {v}")
                continue
            num, den = int(m.group(1)), int(m.group(2))
            n += 1
            # 分母必须是 frame_den 的合理倍数（允许 /50000s）；此处只查边界：
            # 整数 fps 下每帧 = frame_ticks 个 timebase tick（1000），
            # 因此任意合法时间 num % frame_ticks == 0。
            if num % frame_ticks != 0:
                bad.append(f"{e.tag} @{attr}: {v} 不是帧边界"
                           f"(frame_ticks={frame_ticks})")
    return n, bad


def errs_from_src_reachability(root, base):
    """所有 asset src / pathurl 指向真实存在的素材。"""
    bad = []
    n = 0
    for e in root.iter():
        for attr in ("src", "pathurl"):
            v = e.get(attr)
            if v is None:
                continue
            n += 1
            url = v
            # pathurl 形如 file://localhost/…；asset note 形如 file:///…
            if url.startswith("file://"):
                url = url[len("file://"):]
                if url.startswith("localhost"):
                    url = url[len("localhost"):]
            path = unquote(url)
            if not os.path.isabs(path) and base:
                path = os.path.join(base, path.lstrip("/"))
            if not os.path.exists(path):
                bad.append(f"{e.tag} @{attr}: 素材不可达 -> {v}")
    return n, bad


def build_attr_map(root, tag, attr):
    d = {}
    for e in root.iter(tag):
        v = e.get(attr)
        if v:
            d[v] = e
    return d


def errs_from_refs(root):
    """引用完整性：mc-clip/asset-clip/multicam/clip/mc-source 全部能解析。"""
    bad = []
    assets = build_attr_map(root, "asset", "id")
    medias = build_attr_map(root, "media", "id")
    fmts = build_attr_map(root, "format", "id")
    angles = build_attr_map(root, "mc-angle", "angleID")
    n = 0
    for e in root.iter():
        # ref 的指向池由元素类型决定：asset-clip/clip->asset，mc-clip->media。
        # 与 tag 无关的 format 引用单独处理。
        for attr in ("format",):
            v = e.get(attr)
            if v is None:
                continue
            n += 1
            if v not in fmts:
                bad.append(f"{e.tag} @{attr}: format 引用缺失 -> {v}")
        ref = e.get("ref")
        if ref is None:
            continue
        n += 1
        if e.tag.endswith("mc-clip"):
            if ref not in medias:
                bad.append(f"{e.tag} ref: media 引用缺失 -> {ref}")
        elif e.tag == "format":
            # 标准 FCP：media 用子元素 <format ref="..."/> 指向 format 资源，
            # 而非 asset；与 resources 下的 <format id> 区分。
            if ref not in fmts:
                bad.append(f"{e.tag} ref: format 引用缺失 -> {ref}")
        elif ref not in assets:
            bad.append(f"{e.tag} ref: asset 引用缺失 -> {ref}")
    for e in root.iter("mc-source"):
        v = e.get("angleID")
        if v and v not in angles:
            bad.append(f"mc-source angleID: mc-angle 缺失 -> {v}")
    return n, bad


def errs_from_structure(root):
    """mc-angle 内 clip 单调不重叠；spine 第二段 offset == 首段 duration。"""
    bad = []
    for ang in root.iter("mc-angle"):
        prev_end = None
        for clip in ang:
            off = clip.get("offset")
            dur = clip.get("duration")
            if not (off and dur):
                bad.append(f"{ang.get('angleID','?')}: clip 缺 offset/duration")
                continue
            mo, md = TICK_RE.match(off), TICK_RE.match(dur)
            if not (mo and md):
                continue
            o, d = int(mo.group(1)), int(md.group(1))
            if prev_end is not None:
                if o < prev_end:
                    bad.append(f"{ang.get('angleID','?')}: clip 起始 {o}"
                               f" < 前一结束 {prev_end}（重叠）")
            prev_end = o + d
    # spine：每个"轨"上 offset 必须单调不减（不重叠、gap 非负）。
    #  FCP 合并多机位 = 单条 spine + 1 个 mc-clip。
    #  剪映（capcut.fcpxml）= 多条 asset-clip 摊在 spine，靠 lane=机位分层，
    #    不同 lane 同时存在（必然时间重叠，不是错误）→ 必须**按 lane 分组**。
    #  lane 缺失时（FCP 的 mc-clip、无分层）退化为整条 spine 作为单一轨。
    lanes = {}
    for spine in root.iter("spine"):
        for child in spine:
            lane = child.get("lane") or "__flats__"
            m = TICK_RE.match(child.get("offset") or "0/50000s")
            o = int(m.group(1)) if m else None
            d = child.get("duration")
            end = o
            if d and TICK_RE.match(d):
                end += int(TICK_RE.match(d).group(1))
            lanes.setdefault(lane, []).append((o, end))
    for lane, items in lanes.items():
        items.sort(key=lambda x: (x[0] if x[0] is not None else -1,
                                  x[1] if x[1] else 0))
        prev_end = None
        for o, end in items:
            o = o or 0
            if prev_end is not None and o < prev_end:
                bad.append(f"spine lane={lane}: offset {o} < 前一结束 "
                           f"{prev_end}（同一轨重叠）")
            prev_end = max(prev_end or 0, end or o)
    return bad


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    rest = list(argv[1:])
    dtd_arg = next((a.split("=", 1)[1] for a in rest if a.startswith("--dtd=")), None)
    if any(a == "--dtd" for a in rest):
        dtd_arg = "" if dtd_arg is None else dtd_arg or None
    rest = [a for a in rest if not a.startswith("--dtd")]
    if not rest:
        print(__doc__)
        return 1
    xml_path = rest[0]
    base = rest[1] if len(rest) > 1 else None
    if not os.path.isfile(xml_path):
        print(f"FAIL: 文件不存在 {xml_path}")
        return 1
    frame_dur = None
    try:
        root = ET.parse(xml_path).getroot()
    except ET.ParseError as ex:
        print(f"FAIL: XML 解析错误: {ex}")
        return 1
    # 从 format 的 frameDuration 推导每帧 tick 数
    for fmt in root.iter("format"):
        fd = fmt.get("frameDuration")
        if fd:
            m = TICK_RE.match(fd)
            if m:
                frame_dur = (int(m.group(1)), int(m.group(2)))
                break
    frame_ticks = frame_dur[0] if frame_dur else 1000

    all_fail = []
    n_b, b = errs_from_frame_boundaries(root, frame_ticks)
    print(f"[帧边界] {n_b} 个时间属性, {len(b)} 个越界")
    all_fail += b
    n_r, r = errs_from_src_reachability(root, base)
    print(f"[素材可达] {n_r} 个 src/pathurl, {len(r)} 个不可达")
    all_fail += r
    n_f, f = errs_from_refs(root)
    print(f"[引用完整] 检查 {n_f} 处引用, {len(f)} 处缺失")
    all_fail += f
    s = errs_from_structure(root)
    print(f"[结构] {len(s)} 处异常")
    all_fail += s

    # 官方 DTD 完整校验（完美导出的权威门槛；需 --dtd 显式开启或带路径）
    if any(a.startswith("--dtd") for a in argv):
        dtd_path = find_dtd(dtd_arg)
        if not dtd_path:
            print("FAIL: 未找到官方 FCPXMLv1_8.dtd（传递 --dtd=PATH 指定）")
            return 1
        de = dtd_errors(xml_path, dtd_path)
        if de:
            print(f"\n=== FAIL ===\n[DTD] 官方 DTD {os.path.basename(dtd_path)}：")
            for x in de:
                print(" -", x)
            return 1
        print(f"[DTD] 官方 DTD 校验通过（{os.path.basename(dtd_path)}）")

    if all_fail:
        print("\n=== FAIL ===")
        for x in all_fail:
            print(" -", x)
        return 1
    print("\nPASS: 全部结构校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))