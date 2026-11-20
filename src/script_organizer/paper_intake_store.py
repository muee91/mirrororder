"""Immutable project-scoped transcribed paper evidence. No OCR or authority."""
from copy import deepcopy
import hashlib,json,re
from pathlib import Path
from .scene_interval_store import SceneIntervalStore,IntervalConflict
from .slate_log_intake import read_rows,prepare,FIELDS
from .source_descriptor_receipt import _digest
from .paper_scene_token import PAUSE_REASON, is_paper_scene_shorthand

CONTRACT='mirrororder.paper_intake.v1'
RAW_ALIASES={'scene':'scene_raw','shot':'shot_raw','take':'take_raw','date':'date_raw','notes':'notes_raw'}

def _cells(value,path=''):
    if isinstance(value,dict):
        return [cell for key in sorted(value) for cell in _cells(value[key],path+'/'+key.replace('~','~0').replace('/','~1'))]
    if isinstance(value,list):
        return [cell for i,item in enumerate(value) for cell in _cells(item,f'{path}/{i}')]
    return [{'cell':path,'raw':value}]


def _unique_object(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError('duplicate_json_cell_key')
        result[key]=value
    return result


def _bounded_tree(value,depth=0):
    if depth>16:raise ValueError('paper_nesting_exceeded')
    if isinstance(value,dict):
        for item in value.values():_bounded_tree(item,depth+1)
    elif isinstance(value,list):
        for item in value:_bounded_tree(item,depth+1)


def normalize_row(raw):
    """Reuse lexical parser only; identity, dates and cross-row inference are NOT gates."""
    lexical={key:raw.get(key,raw.get(RAW_ALIASES.get(key,''),'')) for key in FIELDS}
    page=raw.get('page',raw.get('pdf_page',''));row=raw.get('row',raw.get('row_index',''))
    if any(type(v) not in (str,int,type(None)) for v in (page,row)):raise ValueError('invalid_page_row_label')
    # Single row prevents implicit ditto propagation, especially across page headers.
    parsed=prepare([{**lexical,'page':str(page),'row':str(row),'text':'transcribed'}],[])['unresolved'][0]
    reasons=[r for r in parsed['reasons'] if (r.startswith('non_string:') or r.startswith('unresolved_ditto:')) and r not in ('non_string:date','unresolved_ditto:date')]
    if not parsed['fields']['scene']:reasons.append('scene_requires_review')
    if not page or row in (None,''):reasons.append('source_locator_missing')
    if raw.get('ambiguities') or raw.get('uncertainties'):reasons.append('transcription_uncertain')
    strings=[c['raw'] for c in _cells(raw) if isinstance(c['raw'],str) and c['cell'] not in ('/date','/date_raw','/day_raw')]
    if any(any(mark in text for mark in ('↑','↓','→','←','↗','↘','划除','涂改','划掉','删除线','strikeout')) for text in strings):reasons.append('original_mark_requires_review')
    return {'fields':parsed['fields'],'reasons':sorted(set(reasons)), 'page':page,'row':row}


class PaperIntakeStore(SceneIntervalStore):
    def __init__(self,output_dir,project_id):
        super().__init__(output_dir,project_id);self.path=Path(output_dir)/'paper_intake.json'
    def snapshot(self):
        if not self.path.exists():return {'contract':CONTRACT,'project_id':self.project_id,'revision':0,'documents':{},'rows':{}}
        value=json.loads(self.path.read_text(encoding='utf-8'))
        if not isinstance(value,dict) or value.get('contract')!=CONTRACT or value.get('project_id')!=self.project_id or type(value.get('revision')) is not int or not isinstance(value.get('rows'),dict) or not isinstance(value.get('documents'),dict):raise ValueError('invalid_paper_store')
        # Detect valid-JSON corruption too: raw identities and derived candidates
        # are recomputed rather than trusting stored candidate_ready or scene.
        seen=set()
        for doc_id,doc in value['documents'].items():
            rows=sorted((r for r in value['rows'].values() if r.get('document_id')==doc_id),key=lambda r:r['import_row_index'])
            if len(rows)!=doc['row_count'] or [r['import_row_index'] for r in rows]!=list(range(len(rows))):raise ValueError('invalid_paper_row_membership')
            digest=_digest({'rows':[r['raw_row'] for r in rows],'page_context':doc.get('page_context',{}),'source_document_digest_claim':doc.get('source_document_digest_claim') or ''})
            if doc_id!='paper-doc-'+digest or doc['digest']!=digest or doc.get('original_document_verified') is not False or doc.get('digest_basis')!='canonical_transcription_json_v1':raise ValueError('paper_document_digest_mismatch')
            if 'derived_lineage' in doc:
                if doc.get('transcription_origin')!='explicit_reviewed_ocr_derivation' or len(rows)!=1 or rows[0]['raw_row'].get('derived_transcription')!=doc['derived_lineage']:raise ValueError('derived_lineage_integrity')
            for i,row in enumerate(rows):
                rid='paper-row-'+_digest({'document':digest,'index':i,'raw':row['raw_row']})
                normalized=normalize_row(row['raw_row'])
                if (value['rows'].get(rid)!=row or row['paper_row_id']!=rid or row['row_digest']!=_digest(row['raw_row'])
                    or row['document_digest']!=digest or row['document_digest_basis']!='canonical_transcription_json_v1'
                    or row.get('source_document_digest_claim')!=doc.get('source_document_digest_claim')
                    or row.get('source_document_digest_verification')!=doc.get('source_document_digest_verification')
                    or row['raw_cells']!=_cells(row['raw_row'])
                    or row['normalized_fields']!=normalized['fields'] or row['review_reasons']!=normalized['reasons']
                    or row['candidate_ready'] is not (not normalized['reasons']) or row['confirmed'] is not False
                    or row['state']!='review_required' or row['page']!=normalized['page'] or row['row']!=normalized['row']):raise ValueError('paper_row_integrity_mismatch')
                seen.add(rid)
        if seen!=set(value['rows']):raise ValueError('orphan_paper_row')
        return value
    def read_model(self):
        data=self.snapshot()
        documents=sorted(data['documents'].values(),key=lambda d:d['import_order'])
        order={d['document_id']:i for i,d in enumerate(documents)}
        rows=sorted(data['rows'].values(),key=lambda r:(order[r['document_id']],r['import_row_index']))
        # Project current review eligibility without rewriting persisted lexical
        # evidence, document identity, row digests or their previous projection.
        rows=[{**r,'candidate_ready':False,'review_reasons':sorted(set(r['review_reasons'])|{PAUSE_REASON})}
              if is_paper_scene_shorthand(r['normalized_fields']['scene']) else r for r in rows]
        return {**data,'documents':documents,'rows':rows,'review_required':True,'editorial_authority':False,
                'limits':{'max_utf8_bytes':2000000,'max_rows':2000,'max_project_rows':10000,'max_documents':100,'max_project_bytes':20000000},
                'summary':{'total_rows':len(rows),'candidate_ready':sum(r['candidate_ready'] for r in rows),'review_required':len(rows),'confirmed':0}}
    def ingest(self,body):
        return self._ingest(body)

    def _ingest(self,body,*,derived_lineage=None):
        allowed={'mode','operation','format','content','expected_revision'}
        if set(body)!=allowed or body.get('mode')!='structured_slate_log.v1' or body.get('operation')!='ingest':raise ValueError('invalid_paper_import_fields')
        content=body['content'];fmt=body['format']
        if not isinstance(content,str) or len(content.encode('utf-8'))>2_000_000:raise ValueError('transcription_size_exceeded')
        metadata={}
        if fmt=='json':
            decoded=json.loads(content,object_pairs_hook=_unique_object)
            _bounded_tree(decoded)
            if isinstance(decoded,dict):
                metadata=decoded;rows=read_rows(json.dumps(decoded.get('rows')),fmt)
            else:rows=read_rows(content,fmt)
        else:rows=read_rows(content,fmt)
        if not 1<=len(rows)<=2000:raise ValueError('paper_row_count_out_of_bounds')
        if any('local_path' in r for r in rows):raise ValueError('device_path_selector_not_persisted')
        source_claim=metadata.get('source_pdf',{})
        if isinstance(source_claim,dict):source_claim=source_claim.get('sha256','')
        if not isinstance(source_claim,str) or not re.fullmatch(r'[a-fA-F0-9]{64}',source_claim):source_claim=''
        source_claim=source_claim.lower()
        page_context=deepcopy(metadata.get('page_context',{}))
        digest=_digest({'rows':rows,'page_context':page_context,'source_document_digest_claim':source_claim})
        import_bytes_digest=hashlib.sha256(content.encode('utf-8')).hexdigest();doc_id='paper-doc-'+digest
        incoming=[];locators=set()
        for i,raw in enumerate(rows):
            normalized=normalize_row(raw);locator=(str(normalized['page']),str(normalized['row']))
            if locator in locators:raise ValueError('duplicate_page_row_locator')
            locators.add(locator)
            rid='paper-row-'+_digest({'document':digest,'index':i,'raw':raw})
            incoming.append({'import_row_index':i,'paper_row_id':rid,'document_id':doc_id,'document_digest':digest,'document_digest_basis':'canonical_transcription_json_v1',
                'source_document_digest_claim':source_claim or None,'source_document_digest_verification':'supplied_unverified' if source_claim else 'not_supplied','row_digest':_digest(raw),'page':normalized['page'],'row':normalized['row'],
                'raw_row':deepcopy(raw),'raw_cells':_cells(raw),'cell_locator_basis':'json_pointer_not_image_coordinates',
                'normalized_fields':normalized['fields'],'review_reasons':normalized['reasons'],
                'state':'review_required','candidate_ready':not normalized['reasons'],'confirmed':False})
        with self._transaction(body['expected_revision']) as data:
            if doc_id in data['documents']:return {**self.read_model(),'import_status':'already_imported','imported_document_id':doc_id}
            if derived_lineage is None and source_claim and any(d.get('source_document_digest_claim')==source_claim for d in data['documents'].values()):
                raise IntervalConflict('same_source_document_changed_transcription_requires_explicit_revision')
            # Do not treat a transcriber's supplied original-PDF digest as verified by Host.
            data['documents'][doc_id]={'import_order':len(data['documents']),'document_id':doc_id,'digest':digest,'digest_basis':'canonical_transcription_json_v1','format':fmt,'row_count':len(rows),'original_document_verified':False,'source_document_digest_claim':source_claim or None,'source_document_digest_verification':'supplied_unverified' if source_claim else 'not_supplied','import_bytes_sha256':import_bytes_digest,'page_context':page_context}
            if derived_lineage is not None:
                if len(rows)!=1 or rows[0].get('derived_transcription')!=derived_lineage:raise ValueError('derived_lineage_mismatch')
                data['documents'][doc_id]['transcription_origin']='explicit_reviewed_ocr_derivation'
                data['documents'][doc_id]['derived_lineage']=deepcopy(derived_lineage)
            for row in incoming:data['rows'][row['paper_row_id']]=row
            if len(data['rows'])>10000 or len(data['documents'])>100 or len(json.dumps(data,ensure_ascii=False).encode('utf-8'))>20_000_000:raise ValueError('project_paper_quota_exceeded')
            self._commit(data)
        return {**self.read_model(),'import_status':'imported','imported_document_id':doc_id}
