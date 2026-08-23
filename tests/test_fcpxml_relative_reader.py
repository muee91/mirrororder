from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from script_organizer.fcpxml_reader import read_fcpxml


def test_reader_resolves_relative_media_against_real_xml_location(tmp_path: Path) -> None:
    media_root = tmp_path / "素材根"
    media = media_root / "A1" / "片段 01.mov"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"media")
    delivery = media_root / "交付"
    delivery.mkdir()
    xml = delivery / "synchronized.fcpxml"
    src = quote("../A1/片段 01.mov", safe="/:@-._~")
    xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<fcpxml version="1.8">'
        '<resources>'
        '<format id="f1" frameDuration="2000/50000s" width="1920" height="1080" />'
        f'<asset id="a1" name="clip" src="{src}" format="f1" duration="50000/50000s" start="0/50000s" hasVideo="1" hasAudio="1" />'
        '</resources>'
        '<library><event name="e"><project name="p"><sequence duration="50000/50000s" format="f1">'
        '<spine><asset-clip name="clip" ref="a1" offset="0/50000s" duration="50000/50000s" start="0/50000s" lane="1" /></spine>'
        '</sequence></project></event></library>'
        '</fcpxml>',
        encoding="utf-8",
    )

    internal = tmp_path / "workspace" / "project" / "output" / "sync" / "synchronized.fcpxml"
    internal.parent.mkdir(parents=True)
    internal.symlink_to(xml)

    clips = read_fcpxml(internal)

    assert len(clips) == 1
    assert clips[0].exists is True
    assert Path(clips[0].media_path) == media.resolve()


def test_reader_keeps_absolute_file_urls_supported(tmp_path: Path) -> None:
    media = tmp_path / "clip.mov"
    media.write_bytes(b"media")
    xml = tmp_path / "absolute.fcpxml"
    xml.write_text(
        '<fcpxml version="1.8"><resources>'
        f'<asset id="a1" name="clip" src="{media.resolve().as_uri()}" duration="1s" />'
        '</resources><library><event name="e"><project name="p"><sequence duration="1s">'
        '<spine><asset-clip name="clip" ref="a1" duration="1s" lane="1" /></spine>'
        '</sequence></project></event></library></fcpxml>',
        encoding="utf-8",
    )
    clips = read_fcpxml(xml)
    assert len(clips) == 1
    assert Path(clips[0].media_path) == media.resolve()
