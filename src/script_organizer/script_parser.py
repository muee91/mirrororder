from __future__ import annotations

import re
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from .models import ScriptSegment

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


@dataclass(frozen=True)
class ScriptDocument:
    segments: tuple[ScriptSegment, ...]

    def episodes(self) -> list[int]:
        return sorted({segment.episode for segment in self.segments})

    def by_episode(self, episode: int) -> list[ScriptSegment]:
        return [segment for segment in self.segments if segment.episode == episode]

    def to_dict(self) -> dict:
        episodes: dict[str, dict] = defaultdict(lambda: {"episode": 0, "scenes": {}})
        for segment in self.segments:
            entry = episodes[str(segment.episode)]
            entry["episode"] = segment.episode
            scene = entry["scenes"].setdefault(segment.scene_id, {"scene_id": segment.scene_id, "segments": []})
            scene["segments"].append(segment.to_dict())
        return {"episodes": list(episodes.values()), "segments": [segment.to_dict() for segment in self.segments]}


def _paragraphs(path: Path) -> list[str]:
    if path.suffix.lower() != ".docx":
        return [
            re.sub(r"\s+", " ", row.lstrip("#").strip()).strip()
            for row in path.read_text(encoding="utf-8").splitlines()
            if row.strip()
        ]
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
    result = []
    for paragraph in document.findall(f".//{{{W_NS}}}body/{{{W_NS}}}p"):
        text = "".join(node.text or "" for node in paragraph.findall(f".//{{{W_NS}}}t"))
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            result.append(text)
    return result


def _episode(text: str) -> int | None:
    match = re.match(r"^第\s*(\d+)\s*集\s*$", text)
    if match:
        return int(match.group(1))
    match = re.match(r"^(\d+)\s*集\s*$", text)
    return int(match.group(1)) if match else None


def _scene(text: str) -> str | None:
    match = re.match(r"^(\d+\s*[-—]\s*\d+)(?:\s|$)", text)
    if match:
        return re.sub(r"\s+", "", match.group(1)).replace("—", "-")
    match = re.match(r"^(?:场|第\s*)\s*([0-9一二三四五六七八九十百]+)\s*场", text)
    return f"场{match.group(1)}" if match else None


def _classify(text: str) -> tuple[str, str, str]:
    match = re.match(r"^([^：:]{1,24})[：:]\s*(.+)$", text)
    if match and not text.startswith(("时间", "地点", "场景")):
        return "dialogue", match.group(1).strip(), match.group(2).strip()
    if text.startswith(("△", "▲", "（", "(", "镜头", "画面")) or text.endswith(("。", "！", "？")):
        return "action", "", text
    return "other", "", text


def parse_script(path: str | Path) -> ScriptDocument:
    paragraphs = _paragraphs(Path(path))
    current_episode: int | None = None
    current_scene = "UNKNOWN"
    scene_numbers: defaultdict[int, int] = defaultdict(int)
    order_by_episode: defaultdict[int, int] = defaultdict(int)
    segments: list[ScriptSegment] = []
    for raw in paragraphs:
        episode = _episode(raw)
        if episode is not None:
            current_episode = episode
            current_scene = "UNKNOWN"
            continue
        if current_episode is None:
            continue
        scene = _scene(raw)
        if scene is not None:
            current_scene = scene
            scene_numbers[current_episode] += 1
        order_by_episode[current_episode] += 1
        kind, speaker, text = ("scene_heading", "", raw) if scene is not None else _classify(raw)
        index = order_by_episode[current_episode]
        segment_id = f"E{current_episode:03d}-S{current_scene.replace('-', '_')}-L{index:04d}"
        segments.append(
            ScriptSegment(
                segment_id=segment_id,
                episode=current_episode,
                scene_id=current_scene or "UNKNOWN",
                order=index,
                type=kind,
                speaker=speaker,
                text=text,
                raw_text=raw,
            )
        )
    return ScriptDocument(tuple(segments))
