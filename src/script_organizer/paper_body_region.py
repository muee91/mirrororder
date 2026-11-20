"""Explicit, device-local draft body crop; geometry, not transcription authority."""
from __future__ import annotations

import json
import re
from .paper_source_binding import make_geometry
from .scene_interval_store import IntervalConflict
from .source_descriptor_receipt import _digest


class PaperBodyRegions:
    def __init__(self, drafts):
        self.drafts = drafts
        with drafts.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS paper_body_regions(
                scope TEXT NOT NULL, draft_id TEXT NOT NULL, page_index INTEGER NOT NULL,
                revision INTEGER NOT NULL, region TEXT,
                PRIMARY KEY(scope,draft_id,page_index))""")

    def _key(self, draft_id, page_index):
        if not isinstance(draft_id, str) or not re.fullmatch(r"pdf-draft-[0-9a-f]{64}", draft_id):
            raise ValueError("draft_identity_invalid")
        if type(page_index) is not int or not 0 <= page_index < 500:
            raise ValueError("draft_page_out_of_range")
        return self.drafts.scope, draft_id, page_index

    def _draft(self, db, key, expected):
        self.drafts.expected(db, expected)
        row = db.execute("SELECT pdf_sha,pages,receipt FROM drafts WHERE scope=? AND id=?", key[:2]).fetchone()
        if not row:
            raise ValueError("unknown_draft")
        sha, pages, receipt = row
        self.drafts.public((key[1], sha, pages))
        if key[2] >= pages:
            raise ValueError("draft_page_out_of_range")
        return sha, receipt

    def _read(self, db, key):
        row = db.execute("""SELECT revision,region FROM paper_body_regions WHERE
                         scope=? AND draft_id=? AND page_index=?""", key).fetchone()
        if row is None:
            return 0, None
        revision, raw = row
        if type(revision) is not int or revision < 1:
            raise ValueError("body_region_store_invalid")
        if raw is None:
            return revision, None
        region = json.loads(raw)
        if not isinstance(region, dict):
            raise ValueError("body_region_store_invalid")
        given_id = region.get("region_id")
        values = {k: v for k, v in region.items() if k != "region_id"}
        if (given_id != self._region_id(values)
                or (region.get("draft_id"), region.get("page_index"), region.get("region_revision")) != (*key[1:], revision)
                or region.get("authority") is not False):
            raise ValueError("body_region_store_invalid")
        return revision, region

    def _region_id(self, values):
        return "paper-body-" + _digest({"scope": self.drafts.scope, "selection": values})

    @staticmethod
    def _payload(scope_revision, draft_id, page_index, page, expected_render_map_id, pixel_rect):
        receipt = page["receipt"]
        render_id = _digest(receipt["render_map"])
        if render_id != expected_render_map_id:
            raise IntervalConflict("render_map_changed")
        if page["draft_id"] != draft_id or page["page_index"] != page_index:
            raise IntervalConflict("selected_page_changed")
        if (not isinstance(pixel_rect, list) or len(pixel_rect) != 4
                or any(type(n) is not int for n in pixel_rect)):
            raise ValueError("integer_pixel_rect_required")
        x0, y0, x1, y1 = pixel_rect
        if not 0 <= x0 < x1 <= receipt["render_map"]["width"] or not 0 <= y0 < y1 <= receipt["render_map"]["height"]:
            raise ValueError("body_rect_outside_canvas")
        corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        return {"draft_id": draft_id, "draft_revision": scope_revision, "draft_version": 1,
                "pdf_sha256": page["pdf_sha256"], "page_index": page_index, "render_map_id": render_id,
                "pixel_rect": pixel_rect.copy(), "pdf_polygon": make_geometry(receipt, corners),
                "region_origin": "explicit_user_selection", "authority": False}

    @staticmethod
    def _result(status, revision, region):
        return {"contract": "mirrororder.paper_body_region.v1", "status": status,
                "region_revision": revision, "region": region, "authority": False}

    def read(self, *, draft_id, expected_draft_revision, page_index):
        key = self._key(draft_id, page_index)
        with self.drafts.connect() as db:
            db.execute("BEGIN")
            sha, first_receipt = self._draft(db, key, expected_draft_revision)
            revision, region = self._read(db, key)
        if region is None:
            return self._result("removed" if revision else "unselected", revision, None)
        if (region["pdf_sha256"] != sha or region["draft_revision"] != expected_draft_revision
                or (page_index == 0 and _digest(json.loads(first_receipt)["render_map"]) != region["render_map_id"])):
            return self._result("stale", revision, None)
        return self._result("selected", revision, region)

    def _change(self, *, draft_id, expected_draft_revision, page_index, expected_region_revision,
                expected_render_map_id, pixel_rect, remove=False):
        key = self._key(draft_id, page_index)
        if type(expected_region_revision) is not int or not 0 <= expected_region_revision < 2**63 - 1:
            raise ValueError("region_revision_required")
        if not isinstance(expected_render_map_id, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_render_map_id):
            raise ValueError("render_map_id_required")
        with self.drafts.selected_page(draft_id=draft_id, expected_draft_revision=expected_draft_revision,
                                       page_index=page_index) as (page, _):
            if remove:
                if _digest(page["receipt"]["render_map"]) != expected_render_map_id:
                    raise IntervalConflict("render_map_changed")
                values = None
            else:
                values = self._payload(expected_draft_revision, draft_id, page_index, page,
                                       expected_render_map_id, pixel_rect)
        # Finish all selected_page postchecks before any commit.
        with self.drafts.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            sha, first_receipt = self._draft(db, key, expected_draft_revision)
            if (sha != page["pdf_sha256"] or (page_index == 0
                    and _digest(json.loads(first_receipt)["render_map"]) != expected_render_map_id)):
                raise IntervalConflict("render_map_changed")
            revision, prior = self._read(db, key)
            if revision != expected_region_revision:
                raise IntervalConflict("body_region_revision_changed")
            if remove and prior is None:
                return self._result("unchanged", revision, None)
            if prior is not None and values is not None and all(prior.get(k) == v for k, v in values.items()):
                return self._result("unchanged", revision, prior)
            revision += 1
            region = None
            if values is not None:
                region = {**values, "region_revision": revision}
                region["region_id"] = self._region_id(region)
            db.execute("""INSERT INTO paper_body_regions VALUES (?,?,?,?,?)
                          ON CONFLICT(scope,draft_id,page_index) DO UPDATE
                          SET revision=excluded.revision,region=excluded.region""",
                       (*key, revision, json.dumps(region, sort_keys=True) if region is not None else None))
            return self._result("removed" if remove else "selected", revision, region)

    def set(self, *, draft_id, expected_draft_revision, page_index, expected_region_revision,
            expected_render_map_id, pixel_rect):
        return self._change(draft_id=draft_id, expected_draft_revision=expected_draft_revision,
                            page_index=page_index, expected_region_revision=expected_region_revision,
                            expected_render_map_id=expected_render_map_id, pixel_rect=pixel_rect)

    def remove(self, *, draft_id, expected_draft_revision, page_index, expected_region_revision,
               expected_render_map_id):
        return self._change(draft_id=draft_id, expected_draft_revision=expected_draft_revision,
                            page_index=page_index, expected_region_revision=expected_region_revision,
                            expected_render_map_id=expected_render_map_id, pixel_rect=None, remove=True)

    def require_current(self, *, draft_id, expected_draft_revision, page_index, region_id, region_revision, page):
        """Worker must provide page from an active, owned selected_page context."""
        result = self.read(draft_id=draft_id, expected_draft_revision=expected_draft_revision, page_index=page_index)
        region = result["region"]
        if (region is None or type(region_revision) is not int or result["region_revision"] != region_revision
                or region["region_id"] != region_id):
            raise IntervalConflict("body_region_changed")
        expected = self._payload(expected_draft_revision, draft_id, page_index, page,
                                 region["render_map_id"], region["pixel_rect"])
        if any(region[k] != v for k, v in expected.items()):
            raise IntervalConflict("body_region_geometry_changed")
        return region
