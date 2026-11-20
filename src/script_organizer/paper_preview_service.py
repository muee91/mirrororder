"""Internal local preview service; no HTTP, frontend path, OCR or authority."""
import hashlib,json,sqlite3
from pathlib import Path
from script_organizer.paper_source_binding import bounded_hash,validate_render_canvas
from script_organizer.scene_interval_store import IntervalConflict

class LocalPaperPreview:
    def __init__(self,paper_store,device_dir,*,native_picker,native_renderer):
        self.paper=paper_store
        self.root=Path(device_dir).resolve();self.root.mkdir(parents=True,exist_ok=True)
        self.cache=self.root/'paper-renders';self.cache.mkdir(exist_ok=True)
        # Context supplied from Host-owned workspace/project, not body fields.
        self.scope=hashlib.sha256((str(paper_store.path.resolve())+'\0'+paper_store.project_id).encode()).hexdigest()
        self.db=self.root/'paper-source-registry.sqlite3'
        self.picker=native_picker;self.renderer=native_renderer
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS renders(scope TEXT, id TEXT, doc_id TEXT, doc_digest TEXT, pdf_path TEXT, png_rel TEXT, receipt TEXT, PRIMARY KEY(scope,id))')
    def _db(self):
        return sqlite3.connect(self.db,timeout=5)
    def _doc(self,data,document_id):
        doc=data['documents'].get(document_id)
        if not doc:raise ValueError('unknown_paper_document')
        claim=doc.get('source_document_digest_claim')
        if not claim:raise ValueError('original_pdf_claim_missing')
        return doc,claim
    def _png(self,path):
        path=Path(path)
        if path.is_symlink():raise ValueError('raster_symlink_rejected')
        resolved=path.resolve(strict=True)
        if self.cache.resolve() not in resolved.parents:raise ValueError('raster_outside_owned_cache')
        return resolved
    def register_selected(self,*,document_id,expected_paper_revision,expected_document_digest,page_index):
        if type(page_index) is not int or page_index<0:raise ValueError('invalid_page')
        # Validate cheap project state before invoking native modal dialog.
        data=self.paper.snapshot();doc,claim=self._doc(data,document_id)
        if data['revision']!=expected_paper_revision or doc['digest']!=expected_document_digest:raise IntervalConflict('paper_changed')
        selected=self.picker()  # Rust-owned dialog result; never a string from HTTP.
        if selected is None:return {'status':'cancelled'}
        original=Path(selected).resolve(strict=True)
        if not original.is_file() or bounded_hash(original,32*1024*1024)!=claim:raise ValueError('selected_pdf_digest_mismatch')
        # Fixed packaged helper implementation injected by trusted Host construction.
        # No command/tool path or renderer kwargs accepted from the caller.
        receipt,png=self.renderer(original,page_index,self.cache,claim)
        png=self._png(png)
        if receipt['pdf_sha256']!=claim or receipt['page_index']!=page_index:raise ValueError('renderer_source_mismatch')
        validate_render_canvas(receipt)
        if bounded_hash(png,64*1024*1024)!=receipt['render_map']['image_sha256']:raise ValueError('raster_digest_mismatch')
        if bounded_hash(original,32*1024*1024)!=claim:raise ValueError('source_changed_during_render')
        binding=hashlib.sha256(json.dumps({'scope':self.scope,'doc':document_id,'receipt':receipt},sort_keys=True,separators=(',',':')).encode()).hexdigest()
        with self.paper._transaction(expected_paper_revision) as current:
            current_doc,_=self._doc(current,document_id)
            if current_doc['digest']!=expected_document_digest:raise IntervalConflict('paper_changed')
            with self._db() as db:
                db.execute('INSERT OR REPLACE INTO renders VALUES(?,?,?,?,?,?,?)',(self.scope,binding,document_id,expected_document_digest,str(original),str(png.relative_to(self.cache)),json.dumps(receipt,ensure_ascii=True)))
        return {'status':'registered','binding_id':binding,'document_id':document_id,'page_index':page_index,
                'pdf_sha256':claim,'authority':False,'ocr_performed':False}
    def _bound(self,binding_id):
        if not isinstance(binding_id,str) or len(binding_id)!=64:raise ValueError('unregistered_binding')
        with self._db() as db:
            row=db.execute('SELECT doc_id,doc_digest,pdf_path,png_rel,receipt FROM renders WHERE scope=? AND id=?',(self.scope,binding_id)).fetchone()
        if not row:raise ValueError('unregistered_binding')
        doc_id,doc_digest,original,relative,raw=row
        receipt=json.loads(raw)
        expected=hashlib.sha256(json.dumps({'scope':self.scope,'doc':doc_id,'receipt':receipt},sort_keys=True,separators=(',',':')).encode()).hexdigest()
        if expected!=binding_id:raise ValueError('registry_receipt_changed')
        validate_render_canvas(receipt)
        doc,claim=self._doc(self.paper.snapshot(),doc_id)
        if doc['digest']!=doc_digest or claim!=receipt['pdf_sha256']:raise ValueError('paper_binding_stale')
        if bounded_hash(original,32*1024*1024)!=claim:raise ValueError('original_pdf_unavailable_or_changed')
        png=self._png(self.cache/relative)
        with png.open('rb') as stream:data=stream.read(64*1024*1024+1)
        if len(data)>64*1024*1024 or hashlib.sha256(data).hexdigest()!=receipt['render_map']['image_sha256']:raise ValueError('raster_unavailable_or_changed')
        return doc_id,receipt,data
    def preview(self,binding_id,*,paper_row_id):
        doc_id,receipt,data=self._bound(binding_id)
        source=self.paper.snapshot();row=source['rows'].get(paper_row_id)
        if not row or row['document_id']!=doc_id:raise ValueError('row_not_in_bound_document')
        if str(row['raw_row'].get('pdf_page',row['raw_row'].get('page')))!=str(receipt['page_number']):raise ValueError('row_not_on_bound_page')
        highlights=[]
        for geom in source.get('source_geometry',{}).values():
            if geom['paper_row_id']==paper_row_id and geom['receipt']==receipt:
                highlights.append({'geometry_id':geom['geometry_id'],'cell_pointer':geom['cell_pointer'],'pdf_polygon':geom['pdf_polygon']})
        dto={'binding_id':binding_id,'paper_row_id':paper_row_id,'revision':source['revision'],'receipt':receipt,
             'highlights':highlights,'source_bytes_currently_checked':True,'authority':False,'ocr_performed':False}
        return dto,data  # Internal transport only; no image URL or exposed path.
    def verified_original_for_row(self,binding_id,*,paper_row_id,expected_paper_revision):
        """Internal bridge from an existing native-picked receipt, never a renderer pathname."""
        view,_=self.preview(binding_id,paper_row_id=paper_row_id)
        if view['revision']!=expected_paper_revision:raise IntervalConflict('paper_changed')
        with self._db() as db:
            record=db.execute('SELECT pdf_path FROM renders WHERE scope=? AND id=?',(self.scope,binding_id)).fetchone()
        if not record:raise ValueError('unregistered_binding')
        path=Path(record[0]).resolve(strict=True);claim=view['receipt']['pdf_sha256']
        if bounded_hash(path,32*1024*1024)!=claim:raise ValueError('original_pdf_unavailable_or_changed')
        return path,claim

    def receipt_reader(self,binding_id):
        return self._bound(binding_id)[1]
    def preview_geometry(self,geometry_id):
        source=self.paper.snapshot();geom=source.get('source_geometry',{}).get(geometry_id)
        if not geom:raise ValueError('unknown_geometry')
        row=source['rows'][geom['paper_row_id']]
        with self._db() as db:
            rows=db.execute('SELECT id,receipt FROM renders WHERE scope=? AND doc_id=?',(self.scope,row['document_id'])).fetchall()
        matching=[binding for binding,receipt in rows if json.loads(receipt)==geom['receipt']]
        if len(matching)!=1:raise ValueError('geometry_local_render_unavailable')
        dto,data=self.preview(matching[0],paper_row_id=row['paper_row_id'])
        if geometry_id not in {x['geometry_id'] for x in dto['highlights']}:raise ValueError('geometry_changed')
        return {'geometry_id':geometry_id,'pdf_sha256':geom['receipt']['pdf_sha256'],
                'image_sha256':geom['receipt']['render_map']['image_sha256'],'png':data}

    def discover_row(self,paper_row_id):
        source=self.paper.snapshot();row=source['rows'].get(paper_row_id)
        if not row:raise ValueError('unknown_paper_row')
        label=row['raw_row'].get('pdf_page',row['raw_row'].get('page'))
        if type(label) not in (int,str) or not str(label).isdigit() or str(label)!=str(int(label)) or int(label)<1:
            return {'status':'unavailable','reason':'pdf_page_unresolved','paper_row_id':paper_row_id}
        with self._db() as db:
            matches=db.execute('SELECT id,receipt FROM renders WHERE scope=? AND doc_id=? ORDER BY rowid DESC LIMIT 501',(self.scope,row['document_id'])).fetchall()
        if len(matches)>500:return {'status':'unavailable','reason':'registry_read_budget','paper_row_id':paper_row_id}
        for binding,raw in matches:
            try:receipt=json.loads(raw)
            except Exception:return {'status':'unavailable','reason':'registry_invalid','paper_row_id':paper_row_id}
            if receipt.get('page_number')!=int(label):continue
            try:
                dto,_=self.preview(binding,paper_row_id=paper_row_id)
            except Exception:return {'status':'unavailable','reason':'registered_source_changed_or_missing','paper_row_id':paper_row_id}
            return {'status':'available','binding_id':binding,'paper_row_id':paper_row_id,
                    'document_id':row['document_id'],'revision':dto['revision'],
                    'pdf_sha256':receipt['pdf_sha256'],'image_sha256':receipt['render_map']['image_sha256'],
                    'page_index':receipt['page_index'],'source_bytes_currently_checked':True}
        return {'status':'not_registered','paper_row_id':paper_row_id,'document_id':row['document_id']}
