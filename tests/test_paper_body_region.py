import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from script_organizer.paper_body_region import PaperBodyRegions
from script_organizer.paper_pdf_drafts import PDFDrafts
from script_organizer.scene_interval_store import IntervalConflict
from script_organizer.source_descriptor_receipt import _digest


@pytest.fixture
def setup(tmp_path):
    src = tmp_path / "synthetic.pdf"
    src.write_bytes(b"synthetic owned PDF bytes; fake native renderer")
    def renderer(path, page, cache, sha):
        png = cache / f"render-{page}.png"
        data = f"synthetic raster {page}".encode()
        png.write_bytes(data)
        return {"pdf_sha256": sha, "pdf_identity_state": "exact_rendered_bytes_sha256",
                "page_index": page, "page_number": page+1, "page_count": 2,
                "cropbox": ["10","10","90","90"], "rotation": 0, "user_unit": "1",
                "pdf_space": "unrotated_pdf_user_space_points_bottom_left",
                "render_map": {"image_sha256": hashlib.sha256(data).hexdigest(), "width": 100, "height": 100,
                               "pixel_to_pdf": ["1","0","0","0","1","0","0","0","1"],
                               "renderer": "synthetic", "transform_history": []},
                "authority": False, "ocr_performed": False}, png

    drafts = PDFDrafts(tmp_path / "device", "w", "p", native_picker=lambda: src, native_renderer=renderer)
    draft = drafts.select(0)["draft"]["draft_id"]
    context = dict(draft_id=draft, expected_draft_revision=1, page_index=0)
    with drafts.selected_page(**context) as (page, _):
        render_map_id = _digest(page["receipt"]["render_map"])
    return drafts, PaperBodyRegions(drafts), context, render_map_id, src


def test_set_worker_idempotence_remove_and_reselect(setup):
    drafts, store, context, render, _ = setup
    assert store.read(**context)["region_revision"] == 0
    selection = dict(expected_render_map_id=render, pixel_rect=[10,20,87,90])
    first = store.set(**context, expected_region_revision=0, **selection)
    row = first["region"]
    assert row["pdf_polygon"] == [["10","20"],["87","20"],["87","90"],["10","90"]]
    assert row["region_origin"] == "explicit_user_selection" and row["authority"] is False
    assert "private_path" not in json.dumps(first)
    ref = dict(region_id=row["region_id"], region_revision=1)
    assert store.set(**context, expected_region_revision=1, **selection)["status"] == "unchanged"
    with drafts.selected_page(**context) as (page, _):
        assert store.require_current(**context, **ref, page=page) == row
    assert store.remove(**context, expected_region_revision=1, expected_render_map_id=render)["region_revision"] == 2
    assert store.read(**context)["status"] == "removed"
    with drafts.selected_page(**context) as (page, _), pytest.raises(IntervalConflict):
        store.require_current(**context, **ref, page=page)
    third = store.set(**context, expected_region_revision=2, **selection)
    assert third["region_revision"] == 3 and third["region"]["region_id"] != row["region_id"]
    assert not Path(drafts.root / "paper_intake.json").exists()


@pytest.mark.parametrize("rect", [[9,20,80,90],[10,20,91,90],[-1,20,80,90],[10,10,10,90],[True,20,80,90],[10.0,20,80,90]])
def test_outside_canvas_crop_or_noninteger_fails_without_write(setup, rect):
    _, store, context, render, _ = setup
    with pytest.raises(ValueError):
        store.set(**context, expected_region_revision=0, expected_render_map_id=render, pixel_rect=rect)
    assert store.read(**context)["region_revision"] == 0


def test_wrong_page_render_revision_and_scope(setup):
    drafts, store, context, render, _ = setup
    selection = dict(expected_render_map_id=render, expected_region_revision=0, pixel_rect=[10,10,90,90])
    with pytest.raises(IntervalConflict, match="render_map_changed"):
        store.set(**{**context, "page_index":1}, **selection)
    with pytest.raises(IntervalConflict, match="draft_revision_changed"):
        store.set(**{**context, "expected_draft_revision":0}, **selection)
    with pytest.raises(ValueError, match="draft_page_out_of_range"):
        store.set(**{**context, "page_index":2}, **selection)
    other = PDFDrafts(drafts.root, "w", "different", native_picker=None, native_renderer=None)
    with pytest.raises(ValueError, match="unknown_draft"):
        PaperBodyRegions(other).read(**{**context, "expected_draft_revision":0})


def test_concurrent_compare_and_swap(setup):
    _, store, context, render, _ = setup
    def save(offset):
        try:
            return store.set(**context, expected_region_revision=0, expected_render_map_id=render,
                             pixel_rect=[10+offset,10,90,90])["status"]
        except IntervalConflict:
            return "conflict"
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(save, [0,1])) == ["conflict","selected"]
    assert store.read(**context)["region_revision"] == 1


def test_changed_physical_pdf_cannot_commit(setup):
    _, store, context, render, source = setup
    source.write_bytes(b"replacement")
    with pytest.raises(ValueError, match="original_pdf_changed"):
        store.set(**context, expected_region_revision=0, expected_render_map_id=render, pixel_rect=[10,10,90,90])
    assert store.read(**context)["region_revision"] == 0
