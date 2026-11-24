"""回归测试：多天/多声道 WAV 自动对轨写入交付 XML、自动帧率探测与常见机位命名推断。"""
from __future__ import annotations

import json
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer.config import ProjectConfig
from script_organizer.media_reader import infer_camera_label
from script_organizer.multicam_sync_engine import run_multicam_sync
from script_organizer.sync_timeline_runtime import build_sync_delivery_artifacts
from script_organizer.timebase import project_timebase


def test_multiday_and_poly_wav_auto_align_and_embed_into_nle_deliveries(tmp_path: Path, monkeypatch) -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("real media tools required")
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))

    root = tmp_path / "media"
    # 两天双机位，各自使用不同随机种子，验证跨天自动波形对轨与 4 声道 Poly-WAV 支持。
    for day, seed in (("day1", 31), ("day2", 47)):
        for camera in "AB":
            folder = root / day / camera
            folder.mkdir(parents=True)
            subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-f", "lavfi",
                    "-i", f"color=c={'red' if camera == 'A' else 'blue'}:size=64x64:rate=25",
                    "-f", "lavfi", "-i", f"anoisesrc=seed={seed}:sample_rate=48000",
                    "-t", "30", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", str(folder / f"{camera}001.mp4"),
                ],
                check=True,
            )

    rec_dir = root / "recording"
    rec_dir.mkdir(parents=True)
    # day1: 4 声道 Poly-WAV（常见片场录音机格式），起始偏移 4 秒
    poly_wav = rec_dir / "D1_POLY4.wav"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-f", "lavfi",
            "-i", "anoisesrc=seed=31:sample_rate=48000",
            "-ss", "4", "-t", "16",
            "-filter_complex", "[0:a]pan=quad|c0=c0|c1=c0|c2=c0|c3=c0[out]",
            "-map", "[out]", "-c:a", "pcm_s16le", str(poly_wav),
        ],
        check=True,
    )
    # day2: 立体声 WAV，起始偏移 6 秒
    day2_wav = rec_dir / "D2_STEREO.wav"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-f", "lavfi",
            "-i", "anoisesrc=seed=47:sample_rate=48000",
            "-ss", "6", "-t", "14", "-ac", "2", "-c:a", "pcm_s16le", str(day2_wav),
        ],
        check=True,
    )

    config = ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="multiday-poly",
        fcpxml=None,
        script=tmp_path / "no-script.txt",
        output_dir=tmp_path / "out",
        transcript_dir=tmp_path / "transcripts",
        input_kind="media-directory",
        media_root=root,
    )
    report = run_multicam_sync(config, sync_context=("ws", "proj", "sync-multiday-1"))

    assert report["diagnostics"][0]["code"] == "waveform_alignment_completed", report["diagnostics"]
    placements = report["recording_alignment"]["placements"]
    assert len(placements) == 2
    by_name = {item["name"]: item for item in placements}
    # day1 (0..750f) 中偏移 4s = 100f；day2 (750..1500f) 中偏移 6s = 750 + 150 = 900f
    assert abs(by_name["D1_POLY4.wav"]["at"] - 100) <= 1
    assert abs(by_name["D2_STEREO.wav"]["at"] - 900) <= 1
    # 不重叠的两条 WAV 应打包到同一条紧凑音轨，而不是各自拆成两条轨
    assert by_name["D1_POLY4.wav"]["track"] == "原录音_1"
    assert by_name["D2_STEREO.wav"]["track"] == "原录音_1"

    embedded = report["audio_delivery_embedded"]
    assert embedded["placement_count"] == 2
    assert embedded["fcpxml"] is True
    assert embedded["capcut_fcpxml"] is True
    assert embedded["premiere_xml"] is True

    # 1. 标准 FCPXML 1.8：包含原 WAV asset 与负 lane asset-clip
    fcp_root = ET.parse(report["fcpxml"]).getroot()
    rec_assets = [el for el in fcp_root.iter("asset") if str(el.get("id", "")).startswith("rec_asset_")]
    assert len(rec_assets) == 2
    assert any(el.get("audioChannels") == "4" for el in rec_assets)
    rec_clips = [el for el in fcp_root.iter("asset-clip") if str(el.get("ref", "")).startswith("rec_asset_")]
    assert len(rec_clips) == 2
    assert all(el.get("lane") == "-1" for el in rec_clips)

    # 2. 剪映 FCPXML 1.8：使用绝对 file:// URL 且包含负 lane asset-clip
    capcut_root = ET.parse(report["capcut_fcpxml"]).getroot()
    capcut_assets = [el for el in capcut_root.iter("asset") if str(el.get("id", "")).startswith("rec_asset_")]
    assert len(capcut_assets) == 2
    assert all(str(el.get("src", "")).startswith("file://") for el in capcut_assets)

    # 3. Premiere FCP7 XML：包含原录音 <track> 与 <clipitem>
    pr_root = ET.parse(report["premiere_xml"]).getroot()
    pr_rec_clips = [el for el in pr_root.iter("clipitem") if str(el.get("id", "")).startswith("rec_")]
    assert len(pr_rec_clips) == 2

    # 4. 交付清单不应把刚自动内嵌好 WAV 的新鲜同步文件误标成 stale，且标注已含原 WAV
    (config.output_dir / "material_index.json").write_text(
        json.dumps({"clips": [{"clip_id": "c1", "camera": "A"}]}),
        encoding="utf-8",
    )
    project = SimpleNamespace(workspace_id="ws", project_id="proj", config=config)
    tasks = [{"task_id": "sync-multiday-1", "type": "multicam_sync", "status": "completed"}]
    manifest = build_sync_delivery_artifacts(project, tasks)
    assert manifest["delivery_state"] == "current"
    assert manifest["stale_reasons"] == []
    standard_artifacts = [item for item in manifest["artifacts"] if item["target"] != "davinci"]
    assert len(standard_artifacts) == 3
    assert all(item["available"] and not item["stale"] and "已对齐原 WAV" in item["format"] for item in standard_artifacts), standard_artifacts


def test_project_timebase_auto_resolves_from_sync_master_and_material_index(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir(parents=True)
    cfg = SimpleNamespace(fcpxml=None, output_dir=out)

    # 空目录仍保守返回 unknown
    assert project_timebase(cfg)["status"] == "unknown"

    # 有 material_index.json 且全片帧率一致（23.976）时自动推导精确分数帧率
    (out / "material_index.json").write_text(
        json.dumps({"clips": [{"clip_id": "c1", "fps": 23.976}, {"clip_id": "c2", "fps": 23.97602}]}),
        encoding="utf-8",
    )
    inferred = project_timebase(cfg)
    assert inferred["status"] == "confirmed"
    assert inferred["source"] == "material_index_probe"
    assert (inferred["numerator"], inferred["denominator"]) == (24000, 1001)

    # 混合帧率保持保守失败关闭，不瞎猜
    (out / "material_index.json").write_text(
        json.dumps({"clips": [{"clip_id": "c1", "fps": 25.0}, {"clip_id": "c2", "fps": 50.0}]}),
        encoding="utf-8",
    )
    assert project_timebase(cfg)["status"] == "unknown"

    # 有已同步母版 synchronized.fcpxml 时优先直接读取母版时间基
    sync_dir = out / "sync"
    sync_dir.mkdir(parents=True)
    (sync_dir / "synchronized.fcpxml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>'
        '<fcpxml version="1.8"><resources><format id="f0" frameDuration="1000/25000s"/></resources>'
        '<library><event name="E"><project name="P"><sequence format="f0" duration="25000/25000s"><spine/></sequence></project></event></library></fcpxml>',
        encoding="utf-8",
    )
    from_sync = project_timebase(cfg)
    assert from_sync["status"] == "confirmed"
    assert from_sync["source"] == "sync_master_fcpxml"
    assert (from_sync["numerator"], from_sync["denominator"]) == (25, 1)


def test_infer_camera_label_recognizes_common_chinese_and_numeric_crew_folders(tmp_path: Path) -> None:
    root = tmp_path / "shoot"
    assert infer_camera_label(root / "主机" / "clip001.mp4", media_roots=(root,)) == "A"
    assert infer_camera_label(root / "副机" / "clip002.mp4", media_roots=(root,)) == "B"
    assert infer_camera_label(root / "1号机" / "0001.mov", media_roots=(root,)) == "A"
    assert infer_camera_label(root / "2号机" / "0002.mov", media_roots=(root,)) == "B"
    assert infer_camera_label(root / "机位3" / "0003.mov", media_roots=(root,)) == "C"
    assert infer_camera_label(root / "CAM1" / "0001.mov", media_roots=(root,)) == "A"
    assert infer_camera_label(root / "CAM2" / "0002.mov", media_roots=(root,)) == "B"
    # 仍不误判带字母后缀的设备文件名
    assert infer_camera_label(root / "misc" / "DJI_0001_D.mp4", media_roots=(root,)) == "?"
