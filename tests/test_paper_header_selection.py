import hashlib
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from script_organizer.paper_header_selection import PaperHeaderSelections
from script_organizer.paper_intake_store import PaperIntakeStore
from script_organizer.paper_pdf_drafts import PDFDrafts
from script_organizer.scene_interval_store import IntervalConflict
from script_organizer.source_descriptor_receipt import _digest


@pytest.fixture
def context(tmp_path):
    source = tmp_path / "original.pdf"
    source.write_bytes(b"synthetic PDF: no native renderer or model")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    def renderer(path, index, cache, sha):
        raster = cache / f"page-{index}.png"
        data = f"synthetic raster {index}".encode()
        raster.write_bytes(data)
        return {"pdf_sha256": sha, "pdf_identity_state": "exact_rendered_bytes_sha256",
                "page_index": index, "page_number": index+1, "page_count": 2, "rotation": 90,
                "cropbox": ["10","10","90","90"], "user_unit": "1",
                "pdf_space": "unrotated_pdf_user_space_points_bottom_left",
                "render_map": {"image_sha256": hashlib.sha256(data).hexdigest(),
                    "width": 100, "height": 100, "pixel_to_pdf": ["0","1","0","-1","0","100","0","0","1"],
                    "renderer": "synthetic", "transform_history": []},
                "authority": False, "ocr_performed": False}, raster
    drafts = PDFDrafts(tmp_path/"device", "w", "p", native_picker=lambda:source, native_renderer=renderer)
    paper = PaperIntakeStore(tmp_path/"project", "p")
    imported = paper.ingest({"mode":"structured_slate_log.v1", "operation":"ingest", "format":"json",
        "expected_revision":0, "content":json.dumps({"source_pdf":{"sha256":digest},"rows":[
            {"pdf_page":1,"row_index":1,"scene_raw":"003","filename":"C0003"},
            {"pdf_page":2,"row_index":1,"scene_raw":"004"}]})})
    draft_id = drafts.select(0)["draft"]["draft_id"]
    page_args = dict(draft_id=draft_id, expected_draft_revision=1, page_index=0)
    with drafts.selected_page(**page_args) as (page, _):
        map_id = _digest(page["receipt"]["render_map"])
    row = imported["rows"][0]
    args = dict(**page_args, expected_render_map_id=map_id, pixel_rect=[10,20,30,40],
                expected_selection_revision=0, expected_paper_revision=1, paper_row_id=row["paper_row_id"],
                row_digest=row["row_digest"], card="B003", camera="B")
    return PaperHeaderSelections(drafts, paper.snapshot, paper_lock=paper._transaction), paper, source, args, imported["rows"]


def test_exact_rotated_header_selection_remains_non_authority(context):
    store, paper, _, args, _ = context
    before = paper.path.read_bytes()
    saved = store.set(**args)
    assert saved["kind"] == "explicit_original_page_header_selection"
    assert saved["current_source_verified"] and saved["authority"] is False
    assert saved["pdf_polygon"] == [["20","90"],["20","70"],["40","70"],["40","90"]]
    assert saved["paper_row_id"] == args["paper_row_id"] and saved["card"] == "B003" and saved["clip_code"] == "C0003"
    assert "private_path" not in json.dumps(saved)
    assert store.read_current(header_id=saved["header_id"], expected_selection_revision=1,
                              expected_paper_revision=1) == saved
    assert paper.path.read_bytes() == before


@pytest.mark.parametrize("changes,error",[
    ({"card":"B003","camera":"A"},"header_card_camera_mismatch"),
    ({"card":"B００３"},"header_card_camera_mismatch"),
    ({"pixel_rect":[0,10,20,30]},"outside_pdf_cropbox"),
    ({"pixel_rect":[0,10,101,30]},"body_rect_outside_canvas"),
    ({"row_digest":"0"*64},"paper_row_changed"),
    ({"expected_paper_revision":0},"paper_revision_changed"),
    ({"expected_draft_revision":0},"draft_revision_changed"),
    ({"expected_render_map_id":"0"*64},"render_map_changed"),
])
def test_no_selection_on_bad_context(context, changes, error):
    store, _, _, args, _ = context
    with pytest.raises((ValueError, IntervalConflict), match=error):
        store.set(**{**args, **changes})
    assert store.revision() == 0


def test_paper_pdf_page_is_machine_page_not_another_row(context):
    store, _, _, args, rows = context
    with pytest.raises(IntervalConflict, match="paper_pdf_page_not_exact"):
        store.set(**{**args,"paper_row_id":rows[1]["paper_row_id"],"row_digest":rows[1]["row_digest"]})


def test_current_read_rechecks_original_bytes_and_header_supersession(context):
    store, _, source, args, _ = context
    first = store.set(**args)
    second = store.set(**{**args, "expected_selection_revision":1, "card":"B004"})
    read = dict(expected_selection_revision=2, expected_paper_revision=1)
    with pytest.raises(IntervalConflict, match="header_selection_superseded"):
        store.read_current(header_id=first["header_id"], **read)
    source.write_bytes(b"changed")
    with pytest.raises(ValueError, match="original_pdf_changed"):
        store.read_current(header_id=second["header_id"], **read)


def test_concurrent_selection_cas(context):
    store, _, _, args, _ = context
    def select(card):
        try:
            return store.set(**{**args,"card":card})["selection_revision"]
        except IntervalConflict:
            return 0
    with ThreadPoolExecutor(2) as executor:
        assert sorted(executor.map(select, ["B003","B004"])) == [0,1]
