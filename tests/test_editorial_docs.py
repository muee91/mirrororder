from __future__ import annotations

from pathlib import Path


def test_editorial_docs_keep_mapping_collaboration_and_delivery_separate() -> None:
    root = Path(__file__).resolve().parents[1]
    contract = (root / "docs" / "review-read-model.md").read_text(encoding="utf-8")
    delivery = (root / "docs" / "delivery-semantics.md").read_text(encoding="utf-8")

    assert "Individual Opinion 不得自动升级为 Editorial Decision" in contract
    assert "selection_manifest.json v3 / delivery.v1" in contract
    assert "不会直接改写 FCPXML" in contract
    assert "当前只允许 Host 本机 / 原生 App 使用" in contract
    assert "Individual Opinion" in contract and "多数票" in contract
    assert "automatic_mapping_fallback" in delivery
    assert "editorial_parent_inheritance = false" in delivery
    assert "mirrororder-delivery.fcpxml" in delivery
