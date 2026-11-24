"""将自动波形对轨后的独立原 WAV 写入多机位同步 NLE 交付文件。

支持三类标准同步交换文件：
- Final Cut Pro / Resolve 标准 FCPXML 1.8（相对路径 `<asset>` + 挂在 `<mc-clip>` 下的负 lane `<asset-clip>`）
- 剪映专业版 / CapCut FCPXML 1.8（绝对 `file://` URL `<asset>` + `<spine>` 负 lane `<asset-clip>`）
- Premiere Pro FCP7 / xmeml v4（`<media><audio>` 下按轨打包的 `<track>` + `<clipitem>`）

所有写入均遵守帧边界、单轨不重叠和媒体根目录边界约束。
"""
from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import quote


def _inside_roots(path: Path, roots: Sequence[Path]) -> bool:
    resolved = path.resolve()
    return any(resolved.is_relative_to(Path(root).resolve()) for root in roots)


def _relative_fcpxml_url(target: Path, xml_dir: Path) -> str:
    rel = os.path.relpath(str(target.resolve()), str(xml_dir.resolve())).replace(os.sep, "/")
    return quote(rel, safe="/:@-._~")


def _absolute_file_url(target: Path) -> str:
    resolved = str(target.resolve()).replace(os.sep, "/")
    if not resolved.startswith("/"):
        resolved = "/" + resolved
    return "file://" + quote(resolved, safe="/:@-._~")


def _premiere_pathurl(target: Path) -> str:
    resolved = str(target.resolve()).replace(os.sep, "/")
    if not resolved.startswith("/"):
        resolved = "/" + resolved
    return "file://localhost" + quote(resolved, safe="/:@-._~")


def _read_fcpxml_timebase(root: ET.Element) -> tuple[int, int]:
    """从 FCPXML `<format frameDuration="T/Ds">` 读取 (frame_ticks, frame_den)。"""
    for fmt in root.iter("format"):
        fd = str(fmt.get("frameDuration", "") or "").strip()
        if fd.endswith("s") and "/" in fd:
            num_s, den_s = fd[:-1].split("/", 1)
            try:
                num, den = int(num_s), int(den_s)
                if num > 0 and den > 0:
                    return num, den
            except ValueError:
                continue
    return 1000, 25000


def _collect_valid_entries(
    *,
    alignment: dict[str, Any],
    local_paths: dict[str, Path],
    inventory: dict[str, Any],
    roots: Sequence[Path],
) -> list[dict[str, Any]]:
    if not isinstance(alignment, dict) or alignment.get("status") != "confirmed":
        return []
    inv_by_id = {
        str(row.get("media_id", "")): row
        for row in (inventory.get("candidates") or [])
        if isinstance(row, dict) and row.get("media_id")
    }
    entries: list[dict[str, Any]] = []
    for raw in alignment.get("placements") or []:
        if not isinstance(raw, dict):
            continue
        media_id = str(raw.get("media_id", "") or "")
        path = local_paths.get(media_id)
        if not path or not path.is_file() or not _inside_roots(path, roots):
            continue
        if path.suffix.lower() != ".wav":
            continue
        at = raw.get("at")
        source = raw.get("source", 0)
        frames = raw.get("frames")
        if (
            type(at) is not int
            or type(source) is not int
            or type(frames) is not int
            or at < 0
            or source < 0
            or frames <= 0
        ):
            continue
        meta = inv_by_id.get(media_id, {})
        sample_rate = int(meta.get("sample_rate") or 48000)
        channels = max(1, int(meta.get("channels") or 1))
        sample_count = int(meta.get("sample_count") or 0)
        entries.append(
            {
                "media_id": media_id,
                "name": str(raw.get("name") or path.name),
                "track": str(raw.get("track") or "原录音_1"),
                "path": path.resolve(),
                "at": at,
                "source": source,
                "frames": frames,
                "sample_rate": sample_rate,
                "channels": channels,
                "sample_count": sample_count,
            }
        )
    entries.sort(key=lambda item: (item["track"], item["at"], item["source"], item["media_id"]))
    return entries


def _assign_negative_lanes(entries: list[dict[str, Any]]) -> list[tuple[int, dict[str, Any]]]:
    """把各条原录音按时间不重叠打包到 -1, -2, ... 负 lane。"""
    lane_ends: list[int] = []
    assigned: list[tuple[int, dict[str, Any]]] = []
    for item in sorted(entries, key=lambda row: (row["at"], row["frames"], row["media_id"])):
        placed_lane: int | None = None
        for idx, end_frame in enumerate(lane_ends):
            if item["at"] >= end_frame:
                lane_ends[idx] = item["at"] + item["frames"]
                placed_lane = -(idx + 1)
                break
        if placed_lane is None:
            lane_ends.append(item["at"] + item["frames"])
            placed_lane = -len(lane_ends)
        assigned.append((placed_lane, item))
    return assigned


def _asset_duration_frames(item: dict[str, Any], rate: Fraction) -> int:
    if item["sample_count"] > 0 and item["sample_rate"] > 0:
        total = Fraction(item["sample_count"], item["sample_rate"]) * rate
        frames = total.numerator // total.denominator
        if frames >= item["source"] + item["frames"]:
            return frames
    return item["source"] + item["frames"]


def _inject_fcpxml(
    xml_path: Path,
    entries: list[dict[str, Any]],
    *,
    absolute_urls: bool,
    attach_to_mc_clip: bool,
) -> bool:
    if not xml_path.is_file() or not entries:
        return False
    tree = ET.parse(xml_path)
    root = tree.getroot()
    resources = root.find("resources")
    if resources is None:
        return False
    frame_ticks, frame_den = _read_fcpxml_timebase(root)
    rate = Fraction(frame_den, frame_ticks)

    # 先清理同一路径历史注入的 rec_asset_ 节点，确保幂等
    for existing in list(resources.findall("asset")):
        if str(existing.get("id", "")).startswith("rec_asset_"):
            resources.remove(existing)

    # 找到挂载容器：FCP 标准版挂在 <sequence><spine><mc-clip> 下；剪映版直接放在 <spine>
    target_parent: ET.Element | None = None
    for project in root.iter("project"):
        seq = project.find("sequence")
        if seq is None:
            continue
        spine = seq.find("spine")
        if spine is None:
            continue
        if attach_to_mc_clip:
            mc = spine.find("mc-clip")
            target_parent = mc if mc is not None else spine
        else:
            target_parent = spine
        break
    if target_parent is None:
        return False

    for child in list(target_parent.findall("asset-clip")):
        if str(child.get("ref", "")).startswith("rec_asset_"):
            target_parent.remove(child)

    # 注册独立原 WAV asset（每个 media_id 一份）
    asset_ids: dict[str, str] = {}
    asset_insert_idx = len(list(resources))
    for idx, child in enumerate(list(resources)):
        if child.tag == "media":
            asset_insert_idx = idx
            break
    for item in entries:
        mid = item["media_id"]
        if mid in asset_ids:
            continue
        aid = f"rec_asset_{len(asset_ids)}"
        asset_ids[mid] = aid
        dur_frames = _asset_duration_frames(item, rate)
        src = (
            _absolute_file_url(item["path"])
            if absolute_urls
            else _relative_fcpxml_url(item["path"], xml_path.parent)
        )
        asset = ET.Element(
            "asset",
            {
                "id": aid,
                "name": Path(item["name"]).stem,
                "src": src,
                "duration": f"{dur_frames * frame_ticks}/{frame_den}s",
                "start": f"0/{frame_den}s",
                "hasVideo": "0",
                "hasAudio": "1",
                "audioSources": "1",
                "audioChannels": str(item["channels"]),
                "audioRate": str(item["sample_rate"]),
            },
        )
        resources.insert(asset_insert_idx, asset)
        asset_insert_idx += 1

    # 按不重叠打包后的负 lane 写入 <asset-clip>
    for lane, item in _assign_negative_lanes(entries):
        clip = ET.Element(
            "asset-clip",
            {
                "name": Path(item["name"]).stem,
                "ref": asset_ids[item["media_id"]],
                "lane": str(lane),
                "offset": f"{item['at'] * frame_ticks}/{frame_den}s",
                "duration": f"{item['frames'] * frame_ticks}/{frame_den}s",
                "start": f"{item['source'] * frame_ticks}/{frame_den}s",
                "tcFormat": "NDF",
                "audioRole": "dialogue.Recorder",
            },
        )
        target_parent.append(clip)

    ET.indent(tree, space="  ")
    tree.write(xml_path, encoding="utf-8", xml_declaration=True)
    return True


def _inject_premiere_xml(xml_path: Path, entries: list[dict[str, Any]]) -> bool:
    if not xml_path.is_file() or not entries:
        return False
    tree = ET.parse(xml_path)
    root = tree.getroot()
    sequence = next(root.iter("sequence"), None)
    if sequence is None:
        return False
    media = sequence.find("media")
    audio = media.find("audio") if media is not None else None
    rate_el = sequence.find("rate")
    if audio is None or rate_el is None:
        return False

    tb_text = (rate_el.findtext("timebase") or "25").strip()
    ntsc_text = (rate_el.findtext("ntsc") or "FALSE").strip()
    rate = Fraction(tb_text) if "/" in tb_text else Fraction(int(tb_text), 1)

    # 清理之前注入的原录音轨，确保幂等
    for track in list(audio.findall("track")):
        first_item = track.find("clipitem")
        if first_item is not None and str(first_item.get("id", "")).startswith("rec_"):
            audio.remove(track)

    by_lane: dict[int, list[dict[str, Any]]] = {}
    for lane, item in _assign_negative_lanes(entries):
        by_lane.setdefault(lane, []).append(item)

    for lane in sorted(by_lane.keys(), reverse=True):
        track_el = ET.SubElement(audio, "track")
        for idx, item in enumerate(by_lane[lane]):
            start_fr = item["at"]
            end_fr = item["at"] + item["frames"]
            in_fr = item["source"]
            out_fr = item["source"] + item["frames"]
            dur_fr = _asset_duration_frames(item, rate)
            stem = Path(item["name"]).stem
            cid = f"rec_a_{abs(lane)}_{idx}_{start_fr}_{end_fr}"
            fid = f"rec_file_{item['media_id']}_{idx}"

            clip = ET.SubElement(track_el, "clipitem", {"id": cid})
            ET.SubElement(clip, "name").text = stem
            ET.SubElement(clip, "start").text = str(start_fr)
            ET.SubElement(clip, "end").text = str(end_fr)
            ET.SubElement(clip, "in").text = str(in_fr)
            ET.SubElement(clip, "out").text = str(out_fr)
            c_rate = ET.SubElement(clip, "rate")
            ET.SubElement(c_rate, "timebase").text = tb_text
            ET.SubElement(c_rate, "ntsc").text = ntsc_text
            ET.SubElement(clip, "enabled").text = "TRUE"

            file_el = ET.SubElement(clip, "file", {"id": fid})
            ET.SubElement(file_el, "name").text = item["name"]
            ET.SubElement(file_el, "pathurl").text = _premiere_pathurl(item["path"])
            f_rate = ET.SubElement(file_el, "rate")
            ET.SubElement(f_rate, "timebase").text = tb_text
            ET.SubElement(f_rate, "ntsc").text = ntsc_text
            ET.SubElement(file_el, "duration").text = str(dur_fr)
            f_media = ET.SubElement(file_el, "media")
            f_audio = ET.SubElement(f_media, "audio")
            sc = ET.SubElement(f_audio, "samplecharacteristics")
            ET.SubElement(sc, "depth").text = "24"
            ET.SubElement(sc, "samplerate").text = str(item["sample_rate"])
            ET.SubElement(sc, "channelcount").text = str(item["channels"])

    ET.indent(tree, space="  ")
    body = ET.tostring(root, encoding="unicode")
    xml_path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + "\n", encoding="utf-8")
    return True


def embed_aligned_recordings_in_deliveries(
    *,
    fcpxml: Path | None,
    capcut_fcpxml: Path | None,
    premiere_xml: Path | None,
    alignment: dict[str, Any] | None,
    local_paths: dict[str, Path],
    inventory: dict[str, Any],
    roots: Sequence[Path],
) -> dict[str, Any]:
    """把自动对齐完成的原 WAV 轨道写入各 NLE 同步交换文件。"""
    entries = _collect_valid_entries(
        alignment=alignment or {},
        local_paths=local_paths,
        inventory=inventory,
        roots=roots,
    )
    if not entries:
        return {
            "fcpxml": False,
            "capcut_fcpxml": False,
            "premiere_xml": False,
            "placement_count": 0,
        }
    return {
        "fcpxml": _inject_fcpxml(fcpxml, entries, absolute_urls=False, attach_to_mc_clip=True) if fcpxml else False,
        "capcut_fcpxml": _inject_fcpxml(capcut_fcpxml, entries, absolute_urls=True, attach_to_mc_clip=False) if capcut_fcpxml else False,
        "premiere_xml": _inject_premiere_xml(premiere_xml, entries) if premiere_xml else False,
        "placement_count": len(entries),
    }


__all__ = ["embed_aligned_recordings_in_deliveries"]
