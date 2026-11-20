"""Fresh local PDF draft prefix. No prefilled transcription/hash or OCR engine."""
import hashlib,json,sqlite3,re
from contextlib import contextmanager
from pathlib import Path
from .paper_source_binding import bounded_hash,validate_render_canvas
from .scene_interval_store import IntervalConflict

class PDFDrafts:
    def __init__(self,device_dir,workspace_id,project_id,*,native_picker,native_renderer):
        if not workspace_id or not project_id:raise ValueError('project_scope_required')
        self.project_id=project_id;self._workspace_id=workspace_id
        self.scope=hashlib.sha256(json.dumps([workspace_id,project_id],separators=(',',':')).encode()).hexdigest()
        self.root=Path(device_dir).resolve();self.root.mkdir(parents=True,exist_ok=True)
        self.cache=self.root/'paper-draft-renders';self.cache.mkdir(exist_ok=True)
        self.db=self.root/'paper-drafts.sqlite3';self.picker=native_picker;self.renderer=native_renderer
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS states(scope TEXT PRIMARY KEY, revision INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS drafts(scope TEXT,id TEXT,pdf_sha TEXT,pages INTEGER,private_path TEXT,png_rel TEXT,receipt TEXT,PRIMARY KEY(scope,id))')
            db.execute('INSERT OR IGNORE INTO states VALUES(?,0)',(self.scope,))
    def connect(self):return sqlite3.connect(self.db,timeout=5)
    def revision(self,db):return db.execute('SELECT revision FROM states WHERE scope=?',(self.scope,)).fetchone()[0]
    def expected(self,db,value):
        if type(value) is not int or value<0:raise ValueError('draft_revision_required')
        if self.revision(db)!=value:raise IntervalConflict('draft_revision_changed')
    def public(self,row):
        draft_id,sha,pages=row[:3]
        if not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha) or type(pages) is not int or not 1<=pages<=500:raise ValueError('draft_metadata_invalid')
        expected='pdf-draft-'+hashlib.sha256(json.dumps([self.scope,sha],separators=(',',':')).encode()).hexdigest()
        if draft_id!=expected:raise ValueError('draft_identity_invalid')
        return {'draft_id':draft_id,'pdf_sha256':sha,'page_count':pages,'draft_version':1,
                'state':'original_pdf_draft','identity_basis':'local_selected_pdf_bytes_sha256',
                'transcription_state':'not_created','ocr_state':'not_run','authority':False,'preview_available_page_indices':[0]}
    def read(self):
        with self.connect() as db:
            db.execute('BEGIN')
            rows=db.execute('SELECT id,pdf_sha,pages FROM drafts WHERE scope=? ORDER BY id LIMIT 101',(self.scope,)).fetchall()
            if len(rows)>100:raise ValueError('draft_quota_corrupt')
            return {'contract':'mirrororder.paper_pdf_drafts.v1','project_id':self.project_id,'revision':self.revision(db),
                    'drafts':[self.public(r) for r in rows],'original_files_currently_checked':False,
                    'limits':{'max_pdf_bytes':33554432,'max_pages':500,'max_drafts':100}}
    def select(self,expected_draft_revision,*,expected_sha=None):
        with self.connect() as db:self.expected(db,expected_draft_revision)
        selected=self.picker()
        if selected is None:return {'status':'cancelled','revision':expected_draft_revision}
        path=Path(selected).resolve(strict=True)
        # Derived from actual chosen file, never accepted from a user JSON field.
        sha=bounded_hash(path,33554432)
        if expected_sha is not None and expected_sha!=sha:raise ValueError("verified_preview_pdf_changed")
        receipt,png=self.renderer(path,0,self.cache,sha)
        if receipt['pdf_sha256']!=sha or receipt['page_index']!=0:raise ValueError('selected_pdf_receipt_mismatch')
        validate_render_canvas(receipt)
        pages=receipt['page_count']
        if type(pages) is not int or not 1<=pages<=500:raise ValueError('pdf_page_budget')
        png=Path(png)
        if png.is_symlink():raise ValueError('draft_raster_symlink')
        png=png.resolve(strict=True)
        if self.cache.resolve() not in png.parents:raise ValueError('draft_raster_outside_owned_cache')
        if bounded_hash(png,33554432)!=receipt['render_map']['image_sha256'] or bounded_hash(path,33554432)!=sha:raise ValueError('draft_source_changed')
        draft_id='pdf-draft-'+hashlib.sha256(json.dumps([self.scope,sha],separators=(',',':')).encode()).hexdigest()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE');self.expected(db,expected_draft_revision)
            old=db.execute('SELECT pdf_sha,pages FROM drafts WHERE scope=? AND id=?',(self.scope,draft_id)).fetchone()
            if old and old!=(sha,pages):raise ValueError('draft_identity_collision')
            if not old and db.execute('SELECT count(*) FROM drafts WHERE scope=?',(self.scope,)).fetchone()[0]>=100:raise ValueError('draft_quota')
            db.execute('INSERT OR REPLACE INTO drafts VALUES(?,?,?,?,?,?,?)',(self.scope,draft_id,sha,pages,str(path),str(png.relative_to(self.cache)),json.dumps(receipt,ensure_ascii=True)))
            if not old:db.execute('UPDATE states SET revision=revision+1 WHERE scope=?',(self.scope,))
            revision=self.revision(db)
        return {'status':'already_registered' if old else 'registered','revision':revision,'draft':self.public((draft_id,sha,pages))}
    def adopt_verified_preview(self,original,sha):
        existing=self.read(); revision=existing['revision']
        same=next((d for d in existing['drafts'] if d['pdf_sha256']==sha),None)
        if same:
            try:
                with self.selected_page(draft_id=same['draft_id'],expected_draft_revision=revision,page_index=0):
                    return {'status':'already_registered','revision':revision,'draft':same}
            except (OSError,ValueError):
                pass
        # Keep the existing writer/receipt format and expected revision CAS.
        # Make a separate constructor so a shared service cannot swap picker state.
        adopter=PDFDrafts(self.root,self._workspace_id,self.project_id,native_picker=lambda:original,native_renderer=self.renderer)
        return adopter.select(revision,expected_sha=sha)

    def ocr_candidate(self,*,draft_id,expected_draft_revision,page_index):
        """Exact single-page request boundary; absent engine is explicit, no job invented."""
        with self.connect() as db:
            db.execute('BEGIN');self.expected(db,expected_draft_revision)
            row=db.execute('SELECT pdf_sha,pages,private_path FROM drafts WHERE scope=? AND id=?',(self.scope,draft_id)).fetchone()
        if not row:raise ValueError('unknown_draft')
        sha,pages,path=row
        self.public((draft_id,sha,pages))
        if type(page_index) is not int or not 0<=page_index<pages:raise ValueError('draft_page_out_of_range')
        if bounded_hash(path,33554432)!=sha:raise ValueError('original_pdf_changed')
        return {'contract':'mirrororder.paper_ocr_candidate_request.v1','status':'blocked','reason':'ocr_engine_unavailable',
                'draft_id':draft_id,'draft_version':1,'pdf_sha256':sha,'page_index':page_index,'page_number':page_index+1,
                'source_bytes_currently_checked':True,'engine_invoked':False,'candidate_created':False,'authority':False}

    def preview_first_page(self,*,draft_id,expected_draft_revision):
        with self.connect() as db:
            db.execute('BEGIN');self.expected(db,expected_draft_revision)
            row=db.execute('SELECT pdf_sha,pages,private_path,png_rel,receipt FROM drafts WHERE scope=? AND id=?',(self.scope,draft_id)).fetchone()
        if not row:raise ValueError('unknown_draft')
        sha,pages,path,relative,raw=row;receipt=json.loads(raw)
        self.public((draft_id,sha,pages))
        if receipt['pdf_sha256']!=sha or receipt['page_count']!=pages or receipt['page_index']!=0:raise ValueError('draft_receipt_mismatch')
        validate_render_canvas(receipt)
        if bounded_hash(path,33554432)!=sha:raise ValueError('original_pdf_changed')
        png=self.cache/relative
        if png.is_symlink() or self.cache.resolve() not in png.resolve(strict=True).parents:raise ValueError('draft_raster_outside_owned_cache')
        with png.open('rb') as stream:data=stream.read(8*1024*1024+1)
        if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!=receipt['render_map']['image_sha256']:raise ValueError('draft_preview_unavailable')
        return {'draft_id':draft_id,'pdf_sha256':sha,'page_index':0,'page_count':pages,'receipt':receipt,
                'highlights':[],'source_bytes_currently_checked':True,'ocr_state':'not_run','authority':False},data


    @contextmanager
    def selected_page(self, *, draft_id, expected_draft_revision, page_index):
        """One owned native render, verified before/after consumption; no UI path."""
        with self.connect() as db:
            db.execute('BEGIN'); self.expected(db,expected_draft_revision)
            row=db.execute('SELECT pdf_sha,pages,private_path FROM drafts WHERE scope=? AND id=?',(self.scope,draft_id)).fetchone()
        if not row:raise ValueError('unknown_draft')
        sha,pages,path=row;self.public((draft_id,sha,pages))
        if type(page_index) is not int or not 0<=page_index<pages:raise ValueError('draft_page_out_of_range')
        if bounded_hash(path,33554432)!=sha:raise ValueError('original_pdf_changed')
        generated=None
        try:
            if page_index==0:
                page,data=self.preview_first_page(draft_id=draft_id,expected_draft_revision=expected_draft_revision)
            else:
                if self.renderer is None:raise ValueError('page_renderer_unavailable')
                receipt,png=self.renderer(Path(path),page_index,self.cache,sha)
                if receipt['pdf_sha256']!=sha or receipt['page_count']!=pages or receipt['page_index']!=page_index:raise ValueError('draft_receipt_mismatch')
                validate_render_canvas(receipt)
                png=Path(png)
                if png.is_symlink() or self.cache.resolve() not in png.resolve(strict=True).parents:raise ValueError('draft_raster_outside_owned_cache')
                generated=png
                with png.open('rb') as stream:data=stream.read(8*1024*1024+1)
                if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!=receipt['render_map']['image_sha256']:raise ValueError('draft_preview_unavailable')
                page={'draft_id':draft_id,'pdf_sha256':sha,'page_index':page_index,'page_count':pages,'receipt':receipt,
                      'highlights':[],'source_bytes_currently_checked':True,'ocr_state':'not_run','authority':False}
            with self.connect() as db:self.expected(db,expected_draft_revision)
            if bounded_hash(path,33554432)!=sha:raise ValueError('original_pdf_changed')
            yield page,data
            with self.connect() as db:self.expected(db,expected_draft_revision)
            if bounded_hash(path,33554432)!=sha:raise ValueError('original_pdf_changed')
            if generated is not None and bounded_hash(generated,8*1024*1024)!=page['receipt']['render_map']['image_sha256']:raise ValueError('draft_preview_unavailable')
            if page_index==0:
                after,after_data=self.preview_first_page(draft_id=draft_id,expected_draft_revision=expected_draft_revision)
                if after['receipt']!=page['receipt'] or after_data!=data:raise ValueError('draft_preview_changed')
        finally:
            if generated is not None:generated.unlink(missing_ok=True)
