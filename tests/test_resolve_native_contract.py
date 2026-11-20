"""Resolve scripting contract tests; the fake is not a Resolve import/playback test."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from script_organizer.nle_delivery.resolve_native import export_native


class Media:
    def __init__(self, path, kind="Video + Audio", mapping="stereo"):
        self.path = path
        self.kind = kind
        self.mapping = mapping

    def GetClipProperty(self, key=None):
        props = {"File Path": self.path, "FPS": "50", "Type": self.kind,
                 "Audio Ch": "2", "Start TC": "00:00:00:00"}
        return props if key is None else props.get(key, "")

    def GetAudioMapping(self):
        return json.dumps({"track_mapping": {"1": {"type": self.mapping}}}) if self.mapping else "{}"

    def GetUniqueId(self):
        return self.path


class Item:
    def __init__(self, spec):
        self.spec = spec

    def GetStart(self, precise=False):
        return self.spec["recordFrame"]

    def GetLeftOffset(self, precise=False):
        return self.spec["startFrame"]

    def GetDuration(self, precise=False):
        return self.spec["endFrame"] - self.spec["startFrame"]

    def GetEnd(self, precise=False):
        return self.GetStart(precise) + self.GetDuration(precise)

    def GetMediaPoolItem(self):
        return self.spec["mediaPoolItem"]


class Timeline:
    def __init__(self, name):
        self.name = name
        self.tracks = {kind: [{"name": "", "items": [], "enabled": True}] for kind in ("video", "audio")}
        self.timecode = None

    def GetName(self):
        return self.name

    def GetStartFrame(self):
        return 180000

    def SetStartTimecode(self, _):
        return True

    def SetCurrentTimecode(self, value):
        self.timecode = value
        return True

    def GetSetting(self, key):
        assert key == "timelineFrameRate"
        return "50"

    def GetTrackCount(self, kind):
        return len(self.tracks[kind])

    def AddTrack(self, kind, layout=None):
        self.tracks[kind].append({"name": "", "items": [], "enabled": True, "layout": layout})
        return True

    def DeleteTrack(self, kind, index):
        self.tracks[kind].pop(index - 1)
        return True

    def SetTrackName(self, kind, index, name):
        self.tracks[kind][index - 1]["name"] = name
        return True

    def GetTrackName(self, kind, index):
        return self.tracks[kind][index - 1]["name"]

    def SetTrackEnable(self, kind, index, enabled):
        self.tracks[kind][index - 1]["enabled"] = enabled
        return True

    def GetIsTrackEnabled(self, kind, index):
        return self.tracks[kind][index - 1]["enabled"]

    def GetItemListInTrack(self, kind, index):
        return self.tracks[kind][index - 1]["items"]

    def GetMediaPoolItem(self):
        raise AssertionError("Never use a timeline as a source clip")


class FakeResolve:
    def __init__(self, media):
        self.media = {str(m.path): m for m in media}
        self.project = None
        self.current = None
        self.timelines = []
        self.page = None

    def GetProjectManager(self):
        return self

    def GetCurrentDatabase(self):
        return {"DbType": "Disk"}

    def GetCurrentProject(self):
        return self if self.project else None

    def GetProjectListInCurrentFolder(self):
        return []

    def CreateProject(self, name):
        self.project = name
        return self

    def GetName(self):
        return self.project

    def GetMediaPool(self):
        return self

    def GetRootFolder(self):
        return self

    def CreateEmptyTimeline(self, name):
        timeline = Timeline(name)
        self.timelines.append(timeline)
        return timeline

    def GetTimelineCount(self):
        return len(self.timelines)

    def SetCurrentTimeline(self, timeline):
        self.current = timeline
        return True

    def CreateMulticamClip(self, *_):
        raise AssertionError("The direct-original export must not create a multicam clip")

    def SetSetting(self, *_):
        return True

    def ImportMedia(self, paths):
        return [self.media[path] for path in paths]

    def AppendToTimeline(self, specs):
        items = []
        for spec in specs:
            item = Item(spec)
            kind = "video" if spec["mediaType"] == 1 else "audio"
            self.current.GetItemListInTrack(kind, spec["trackIndex"]).append(item)
            items.append(item)
        return items

    def OpenPage(self, page):
        self.page = page
        return True

    def SaveProject(self):
        return True

    def ExportProject(self, name, destination, *_):
        assert name == self.project
        with zipfile.ZipFile(destination, "w") as archive:
            archive.writestr("synthetic.xml", "<SyntheticResolveProject/>")
        return True

    def GetVersionString(self):
        return "fake"


@pytest.fixture
def synthetic(tmp_path):
    cameras = "ABC"
    media = [Media(str(tmp_path / f"camera-{camera}.mov")) for camera in cameras]
    media.append(Media(str(tmp_path / "original.wav"), "Audio", "mono"))
    tracks = [{"camera": camera, "clips": [{"path": item.path, "name": f"{camera}.mov", "at": index,
                 "frames": 50, "source": 0, "source_kind": "original", "media_id": f"M_video_{camera}"}]}
              for index, (camera, item) in enumerate(zip(cameras, media))]
    recordings = [{"track": "同期 MIC 1", "path": media[-1].path, "name": "original.wav",
                   "at": 4, "frames": 25, "source": 7, "source_kind": "original", "media_id": "M_recorder",
                   "timing_basis": "original_unretimed", "source_rate_ratio": [1, 1]}]
    for item in media:
        Path(item.path).write_bytes(b"synthetic media unchanged by export")
    plan = {"contract_version": "resolve_sync_originals.v1", "project_name": "Synthetic",
            "rate": [50, 1], "size": [1920, 1080], "frames": 52, "gaps": 0, "opening_frame": 4,
            "sync_task_id": "synthetic-sync",
            "tracks": tracks, "recordings": recordings}
    return media, plan, tmp_path / "test.drp"


def test_exports_direct_camera_originals_and_preserves_wav_on_master(synthetic):
    media, plan, destination = synthetic
    resolve = FakeResolve(media)

    receipt = export_native(resolve, plan, destination)

    master, conversion = resolve.timelines
    assert master.GetName() == "同步母版（原片直连）"
    assert conversion.GetName() == "待转换多机位（原片直连）"
    for timeline in (master, conversion):
        assert timeline.GetTrackCount("video") == 3
        for index, (camera, expected) in enumerate(zip("ABC", media), 1):
            assert timeline.GetTrackName("video", index) == f"机位 {camera}"
            item, = timeline.GetItemListInTrack("video", index)
            assert item.GetMediaPoolItem() is expected
            assert item.GetStart(True) == timeline.GetStartFrame() + index - 1
            assert item.GetDuration(True) == 50 and item.GetLeftOffset(True) == 0
    rec = next(index for index in range(1, master.GetTrackCount("audio") + 1)
               if master.GetTrackName("audio", index) == "同期 MIC 1")
    wav, = master.GetItemListInTrack("audio", rec)
    assert wav.GetMediaPoolItem() is media[-1]
    assert wav.GetStart(True) == master.GetStartFrame() + 4
    assert wav.GetLeftOffset(True) == 7 and wav.GetDuration(True) == 25
    assert master.GetIsTrackEnabled("audio", rec)
    assert not any(track["items"] for track in conversion.tracks["audio"])
    assert receipt["delivery_kind"] == "direct_sync_timeline"
    assert receipt["native_multicam"] is False
    assert receipt["conversion_required"] is True
    assert receipt["cameras"] == list("ABC") and receipt["audio_segments"] == 1
    deps = receipt["media_dependencies"]
    assert {row["path"] for row in deps} == {item.path for item in media}
    assert all(row["source_kind"] == "original" and row["media_id"].startswith("M_") for row in deps)
    assert {row["camera"] for row in deps if "camera" in row} == set("ABC")
    assert {row["track"] for row in deps if row["path"] == media[-1].path} == {"同期 MIC 1"}
    assert receipt["audio_tail_trims"] == 0
    assert resolve.current is master and resolve.page == "edit"
    assert destination.is_file()


@pytest.mark.parametrize("kind", ["Timeline", "Compound Clip"])
def test_fails_if_resolve_import_resolves_to_nested_media(synthetic, kind):
    media, plan, destination = synthetic
    media[0].kind = kind

    with pytest.raises((RuntimeError, ValueError)):
        export_native(FakeResolve(media), plan, destination)

    assert not destination.exists()


def test_fails_unproven_independent_wav_layout_instead_of_guessing_stereo(synthetic):
    media, plan, destination = synthetic
    media[-1].mapping = None

    with pytest.raises((RuntimeError, ValueError)):
        export_native(FakeResolve(media), plan, destination)

    assert not destination.exists()


def test_fails_when_resolve_spills_original_wav_into_other_track(synthetic):
    media, plan, destination = synthetic

    class SpillResolve(FakeResolve):
        def AppendToTimeline(self, specs):
            items = super().AppendToTimeline(specs)
            if specs[0]["mediaType"] == 2 and specs[0]["mediaPoolItem"] is media[-1]:
                original_index = specs[0]["trackIndex"]
                self.current.GetItemListInTrack("audio", original_index).remove(items[0])
                self.current.GetItemListInTrack("audio", original_index + 1).append(items[0])
            return items

    with pytest.raises((RuntimeError, ValueError)):
        export_native(SpillResolve(media), plan, destination)

    assert not destination.exists()


@pytest.mark.parametrize("field,value", [
    ("source_kind", "corrected"),
    ("timing_basis", "retimed"),
    ("source_rate_ratio", [1001, 1000]),
])
def test_fails_closed_when_a_wav_plan_is_not_original_unretimed(synthetic, field, value):
    media, plan, destination = synthetic
    plan["recordings"][0][field] = value
    resolve = FakeResolve(media)

    with pytest.raises((RuntimeError, ValueError)):
        export_native(resolve, plan, destination)

    assert resolve.project is None
    assert not destination.exists()
