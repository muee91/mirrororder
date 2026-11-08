from script_organizer.evidence_contract import (
    CONTRACT,
    EvidenceItem,
    EvidenceProvenance,
    EvidenceSidecar,
    EvidenceSpan,
)


def test_evidence_sidecar_round_trips_provider_evidence_without_authority() -> None:
    original = EvidenceSidecar(
        asset_id="M_abc",
        content_hash="sha256:abc",
        display_name="A001.mov",
        take_id="take-1",
        multicam_group_id="mc-1",
        items=(
            EvidenceItem(
                kind="transcript",
                value="你好",
                span=EvidenceSpan(1.0, 2.5, source_timecode="00:00:01:00"),
                speaker="speaker-1",
                provenance=EvidenceProvenance("whisper.cpp", "small", "1"),
            ),
        ),
    )
    restored = EvidenceSidecar.from_dict(original.to_dict())
    assert restored == original
    assert restored.schema == CONTRACT
    assert restored.items[0].provenance.provider == "whisper.cpp"
