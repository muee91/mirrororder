from __future__ import annotations

from pathlib import Path


def test_editorial_docs_keep_legacy_export_and_collaboration_separate() -> None:
    root = Path(__file__).resolve().parents[1]
    contract = (root / "docs" / "review-read-model.md").read_text(encoding="utf-8")
    migration = (root / "docs" / "editorial-collaboration.md").read_text(encoding="utf-8")

    assert "Individual Opinion 不得自动升级为 Editorial Decision" in contract
    assert "尚未替代 `review.json`" in contract
    assert "最终决定只允许 Host 本机或原生 App 写入" in migration
    assert "selection manifest / FCPXML" in migration
