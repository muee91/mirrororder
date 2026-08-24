from pathlib import Path


def test_media_camera_semantics_document_product_boundaries() -> None:
    root = Path(__file__).resolve().parents[1]
    doc = (root / "docs" / "media-camera-semantics.md").read_text(encoding="utf-8")
    sync = (root / "SYNC_MODEL.md").read_text(encoding="utf-8")

    assert "media_roles.v1" in doc
    assert "A机 / B机 / C机" in doc
    assert "普通单词里偶然出现 A/B/C 不构成机位证据" in doc
    assert "没有时间码、没有音频，不等于“同步失败”" in doc
    assert "sync_policy=exclude" in doc
    assert "辅助素材不成为 Take" in doc
    assert "不自动替代 Best" in doc
    assert "普通团队 Web 不提供素材目录扫描" in doc
    assert "不得自动成为 Take、Best 或 Primary" in doc

    assert "media_roles.json" in sync
    assert "camera_override" in sync
    assert "绝对素材路径" in sync
    assert "普通 Web 不提供素材目录扫描" in sync
