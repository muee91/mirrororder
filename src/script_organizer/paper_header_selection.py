"""Explicit original-page header selection, without OCR or paper authority."""
from contextlib import nullcontext
import json
import re

from .paper_body_region import PaperBodyRegions
from .scene_interval_store import IntervalConflict
from .source_descriptor_receipt import _digest



def reviewed_paper_camera(state,row):
    """Only trusted, explicit filename-column interpretation; never infer it."""
    doc=state['documents'].get(row.get('document_id'),{})
    lineage=doc.get('derived_lineage')
    if doc.get('transcription_origin')!='explicit_reviewed_ocr_derivation' or not isinstance(lineage,dict):
        return None
    mappings=[m for m in lineage.get('column_mapping',[]) if m.get('field')=='filename' and 'paper_camera' in m]
    if not mappings:return None
    if len(mappings)!=1:raise ValueError('ambiguous_reviewed_paper_camera')
    mapping=mappings[0]
    camera=mapping['paper_camera']
    cells=[c for c in lineage.get('reviewed_cells',[]) if c.get('machine_original',{}).get('column_index')==mapping.get('column_index')]
    if (camera not in ('A','B','C') or len(cells)!=1 or cells[0].get('transcription_status')!='reviewed_text' or cells[0].get('action') not in ('accept','correct')
            or not cells[0].get('reviewed_text') or cells[0]['reviewed_text']!=row['raw_row'].get('filename')):
        raise ValueError('reviewed_paper_camera_integrity')
    return camera


class PaperHeaderSelections:
    def __init__(self, drafts, paper_reader, *, paper_lock=None):
        self.drafts = drafts
        self.paper_reader = paper_reader
        self.paper_lock = paper_lock
        with drafts.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS paper_header_selections(
                scope TEXT NOT NULL, header_id TEXT NOT NULL, revision INTEGER NOT NULL,
                paper_row_id TEXT NOT NULL, content TEXT NOT NULL,
                PRIMARY KEY(scope,header_id), UNIQUE(scope,revision))""")

            db.execute('''CREATE TABLE IF NOT EXISTS electronic_header_current(
                scope TEXT NOT NULL, slot TEXT NOT NULL, header_id TEXT NOT NULL, revision INTEGER NOT NULL,
                PRIMARY KEY(scope,slot))''')

    @staticmethod
    def _electronic_slot(payload):
        cell=payload.get('electronic_source_cell')
        if cell is None:return None
        if not isinstance(cell,dict) or cell.get('paper_row_id')!=payload.get('paper_row_id') or cell.get('camera')!=payload.get('camera'):
            raise IntervalConflict('electronic_header_slot_invalid')
        return _digest([cell['paper_row_id'],cell['raw_cell']])

    def _revision(self, db):
        return db.execute("SELECT coalesce(max(revision),0) FROM paper_header_selections WHERE scope=?",
                          (self.drafts.scope,)).fetchone()[0]

    def revision(self):
        with self.drafts.connect() as db:
            return self._revision(db)

    @staticmethod
    def _check_expected(expected):
        if type(expected) is not int or not 0 <= expected < 2**63 - 1:
            raise ValueError("header_selection_revision_required")

    def _row(self, paper_row_id, row_digest, expected_paper_revision):
        if type(expected_paper_revision) is not int or expected_paper_revision < 0:
            raise ValueError("paper_revision_required")
        if (not isinstance(paper_row_id, str) or not re.fullmatch(r"paper-row-[0-9a-f]{64}", paper_row_id)
                or not isinstance(row_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", row_digest)):
            raise ValueError("paper_row_identity_required")
        state = self.paper_reader()
        if state["project_id"] != self.drafts.project_id:
            raise IntervalConflict("paper_project_changed")
        if state["revision"] != expected_paper_revision:
            raise IntervalConflict("paper_revision_changed")
        row = state["rows"].get(paper_row_id)
        if not row or row.get("paper_row_id") != paper_row_id or row.get("row_digest") != row_digest:
            raise IntervalConflict("paper_row_changed")
        raw = row.get("raw_row")
        if not isinstance(raw, dict) or _digest(raw) != row_digest:
            raise IntervalConflict("paper_row_digest_changed")
        return {**row,"_reviewed_paper_camera":reviewed_paper_camera(state,row)}

    @staticmethod
    def _clip_code(row):
        fields = row.get("normalized_fields")
        value = fields.get("filename") if isinstance(fields, dict) else None
        return value if isinstance(value, str) else ""

    @staticmethod
    def _check_paper_camera(row, camera, payload=None):
        known=row["_reviewed_paper_camera"]
        if known is not None and (camera!=known or (payload is not None and payload.get("reviewed_paper_camera")!=known)):
            raise IntervalConflict("reviewed_paper_camera_conflict")

    @staticmethod
    def _electronic_cell(row,nested_camera,actual_camera):
        from .paper_nested_camera import require_cell
        if nested_camera!=actual_camera:raise IntervalConflict('electronic_paper_camera_conflict')
        return require_cell(row,nested_camera,row['row_digest'])

    def _verify_saved_code(self,row,payload):
        electronic=payload.get('electronic_source_cell')
        if electronic is not None:
            if not isinstance(electronic,dict):raise IntervalConflict('electronic_source_cell_changed')
            computed=self._electronic_cell(row,electronic.get('camera'),payload['camera'])
            if computed!=electronic or payload.get('reviewed_paper_camera')!=computed['camera']:
                raise IntervalConflict('electronic_source_cell_changed')
            code=computed['code']
        else:
            code=self._clip_code(row)
        if payload.get('clip_code')!=code:raise IntervalConflict('paper_row_clip_code_changed')

    def _validate_page(self, row, page, context, render_map_id, rect):
        raw = row["raw_row"]
        label = raw.get("pdf_page", raw.get("page"))
        if type(label) not in (str, int) or str(label) != str(page["receipt"]["page_number"]):
            raise IntervalConflict("paper_pdf_page_not_exact")
        if row.get("source_document_digest_claim") != page["pdf_sha256"]:
            raise IntervalConflict("original_pdf_claim_missing_or_mismatch")
        return PaperBodyRegions._payload(context["expected_draft_revision"], context["draft_id"],
                                         context["page_index"], page, render_map_id, rect)

    def _draft_fence(self, db, context, payload):
        self.drafts.expected(db, context["expected_draft_revision"])
        row = db.execute("SELECT pdf_sha,pages,receipt FROM drafts WHERE scope=? AND id=?",
                         (self.drafts.scope, context["draft_id"])).fetchone()
        if not row or row[0] != payload["pdf_sha256"] or not 0 <= context["page_index"] < row[1]:
            raise IntervalConflict("selected_page_changed")
        if context["page_index"] == 0 and _digest(json.loads(row[2])["render_map"]) != payload["render_map_id"]:
            raise IntervalConflict("render_map_changed")

    def _id(self, payload):
        return "paper-header-" + _digest({"scope": self.drafts.scope, "selection": payload})

    def _paper_lock(self, revision):
        return self.paper_lock(revision) if self.paper_lock is not None else nullcontext()

    def set(self, *, draft_id, expected_draft_revision, page_index, expected_render_map_id,
            pixel_rect, expected_selection_revision, expected_paper_revision, paper_row_id,
            row_digest, card, camera, nested_camera=None):
        self._check_expected(expected_selection_revision)
        if (not isinstance(card, str) or not re.fullmatch(r"[ABC][0-9]{3}", card)
                or not isinstance(camera, str) or camera != card[0]):
            raise ValueError("header_card_camera_mismatch")
        row = self._row(paper_row_id, row_digest, expected_paper_revision)
        self._check_paper_camera(row,camera)
        electronic=self._electronic_cell(row,nested_camera,camera) if nested_camera is not None else None
        context = dict(draft_id=draft_id, expected_draft_revision=expected_draft_revision, page_index=page_index)
        with self.drafts.selected_page(**context) as (page, _):
            geometry = self._validate_page(row, page, context, expected_render_map_id, pixel_rect)
        payload = {**geometry, "kind": "explicit_original_page_header_selection",
                   "paper_row_id": paper_row_id, "row_digest": row_digest, "card": card,
                   "camera": camera, "paper_revision": expected_paper_revision,
                   "clip_code": electronic["code"] if electronic else self._clip_code(row)}
        if row["_reviewed_paper_camera"] is not None:payload["reviewed_paper_camera"]=row["_reviewed_paper_camera"]
        if electronic is not None:
            payload.update(electronic_source_cell=electronic,reviewed_paper_camera=electronic["camera"])
        payload.pop("region_origin")
        with self._paper_lock(expected_paper_revision), self.drafts.connect() as db:
            if self._row(paper_row_id, row_digest, expected_paper_revision) != row:
                raise IntervalConflict("paper_row_changed")
            db.execute("BEGIN IMMEDIATE")
            self._draft_fence(db, context, payload)
            if self._revision(db) != expected_selection_revision:
                raise IntervalConflict("header_selection_revision_changed")
            payload["selection_revision"] = expected_selection_revision + 1
            header_id = self._id(payload)
            db.execute("INSERT INTO paper_header_selections VALUES(?,?,?,?,?)",
                       (self.drafts.scope, header_id, payload["selection_revision"], paper_row_id,
                        json.dumps(payload, sort_keys=True)))
            slot=self._electronic_slot(payload)
            if slot is not None:
                db.execute("INSERT OR REPLACE INTO electronic_header_current VALUES(?,?,?,?)",
                           (self.drafts.scope,slot,header_id,payload['selection_revision']))
            if self._row(paper_row_id, row_digest, expected_paper_revision) != row:
                raise IntervalConflict("paper_row_changed")
        return {**payload, "header_id": header_id, "current_source_verified": True}

    def _content(self, db, header_id, expected_selection_revision):
        row = db.execute("SELECT revision,paper_row_id,content FROM paper_header_selections WHERE scope=? AND header_id=?",
                         (self.drafts.scope, header_id)).fetchone()
        if not row:raise IntervalConflict("unknown_header_selection")
        revision,paper_row_id,raw=row
        payload=json.loads(raw)
        if (not isinstance(payload,dict) or self._id(payload)!=header_id
                or payload.get("selection_revision")!=revision or payload.get("paper_row_id")!=paper_row_id
                or payload.get("kind")!="explicit_original_page_header_selection" or payload.get("authority") is not False):
            raise ValueError("header_selection_integrity")
        slot=self._electronic_slot(payload)
        if slot is not None:
            if revision!=expected_selection_revision:raise IntervalConflict("electronic_header_generation_changed")
            current=db.execute("SELECT header_id,revision FROM electronic_header_current WHERE scope=? AND slot=?",
                               (self.drafts.scope,slot)).fetchone()
            if current!=(header_id,revision):raise IntervalConflict("electronic_header_slot_superseded")
        else:
            if self._revision(db)!=expected_selection_revision:raise IntervalConflict("header_selection_revision_changed")
            latest=db.execute("SELECT max(revision) FROM paper_header_selections WHERE scope=? AND paper_row_id=?",
                              (self.drafts.scope,paper_row_id)).fetchone()[0]
            if latest!=revision:raise IntervalConflict("header_selection_superseded")
        return payload

    def read_current(self, *, header_id, expected_selection_revision, expected_paper_revision):
        self._check_expected(expected_selection_revision)
        if not isinstance(header_id, str) or not re.fullmatch(r"paper-header-[0-9a-f]{64}", header_id):
            raise ValueError("header_selection_identity_required")
        with self.drafts.connect() as db:
            db.execute("BEGIN")
            payload = self._content(db, header_id, expected_selection_revision)
        if payload["paper_revision"] != expected_paper_revision:
            raise IntervalConflict("paper_revision_changed")
        row = self._row(payload["paper_row_id"], payload["row_digest"], expected_paper_revision)
        self._check_paper_camera(row,payload["camera"],payload)
        self._verify_saved_code(row,payload)
        context = dict(draft_id=payload["draft_id"], expected_draft_revision=payload["draft_revision"],
                       page_index=payload["page_index"])
        with self.drafts.selected_page(**context) as (page, _):
            geometry = self._validate_page(row, page, context, payload["render_map_id"], payload["pixel_rect"])
            if any(payload.get(key) != value for key, value in geometry.items() if key != "region_origin"):
                raise IntervalConflict("header_geometry_changed")
        with self._paper_lock(expected_paper_revision), self.drafts.connect() as db:
            db.execute("BEGIN")
            if self._content(db, header_id, expected_selection_revision) != payload:
                raise IntervalConflict("header_selection_changed")
            self._draft_fence(db, context, payload)
            if self._row(payload["paper_row_id"], payload["row_digest"], expected_paper_revision) != row:
                raise IntervalConflict("paper_row_changed")
        return {**payload, "header_id": header_id, "current_source_verified": True}


    def read_bound_source(self, *, header_id, expected_selection_revision, expected_paper_revision):
        """Revalidate already authored geometry against the exact same PDF bytes.

        No rerender: native prepare established the geometry. Integrity, current
        page/header/draft revisions, and PDF bytes are checked again at egress.
        Caller holds the paper transaction lock.
        """
        from .paper_source_binding import bounded_hash
        self._check_expected(expected_selection_revision)
        with self.drafts.connect() as db:
            db.execute("BEGIN")
            payload=self._content(db,header_id,expected_selection_revision)
            if payload["paper_revision"]!=expected_paper_revision:
                raise IntervalConflict("paper_revision_changed")
            row=self._row(payload["paper_row_id"],payload["row_digest"],expected_paper_revision)
            self._check_paper_camera(row,payload["camera"],payload)
            self._verify_saved_code(row,payload)
            context={"draft_id":payload["draft_id"],"expected_draft_revision":payload["draft_revision"],"page_index":payload["page_index"]}
            self._draft_fence(db,context,payload)
            dbrow=db.execute("SELECT private_path FROM drafts WHERE scope=? AND id=?",(self.drafts.scope,payload["draft_id"])).fetchone()
            if row.get("source_document_digest_claim")!=payload["pdf_sha256"] or bounded_hash(dbrow[0],33554432)!=payload["pdf_sha256"]:
                raise IntervalConflict("original_pdf_changed")
        with self.drafts.connect() as db:
            db.execute("BEGIN")
            if self._content(db,header_id,expected_selection_revision)!=payload:
                raise IntervalConflict("header_selection_changed")
            self._draft_fence(db,context,payload)
        return {**payload,"header_id":header_id,"current_source_verified":True}
