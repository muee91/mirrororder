"""Fixed native helper adapter. Constructor path is supplied by packaged Rust."""
import json,subprocess,uuid,time
from pathlib import Path
from script_organizer.paper_source_binding import canonical_native

class NativePDFRenderer:
    def __init__(self,helper,*,cancelled=lambda:False):self.helper=Path(helper);self.cancelled=cancelled
    def __call__(self,source,page_index,cache,expected_pdf_sha256):
        if not self.helper.is_file():raise ValueError('packaged_native_pdf_renderer_missing')
        selection_id=uuid.uuid4().hex;output=Path(cache)/(selection_id+'.png')
        request=dict(pdf_path=str(source),expected_pdf_sha256=expected_pdf_sha256,page_index=page_index,output_png=str(output),selection_id=selection_id)
        from .resource_scheduler import ResourceCancelled
        if self.cancelled():raise ResourceCancelled("原页渲染已取消")
        process=subprocess.Popen([str(self.helper)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+23
        data=json.dumps(request,ensure_ascii=True).encode('ascii')
        try:
            while True:
                if self.cancelled():raise ResourceCancelled("原页渲染已取消")
                if time.monotonic()>deadline:raise ValueError('native_pdf_render_timeout')
                try:
                    stdout,_=process.communicate(input=data,timeout=.1)
                    break
                except subprocess.TimeoutExpired:data=None
            if process.returncode or len(stdout)>1_048_576:raise ValueError('native_pdf_render_failed')
            receipt=json.loads(stdout)
        except BaseException:
            if process.poll() is None:process.kill()
            process.wait()
            output.unlink(missing_ok=True)
            raise
        if receipt.get('status')!='rendered' or receipt.get('schema')!='mirrororder.native_pdf_render.v1' or receipt.get('selection_id')!=selection_id or receipt.get('document_sha256')!=expected_pdf_sha256 or receipt.get('page_index')!=page_index:raise ValueError('native_pdf_receipt_mismatch')
        return canonical_native(receipt,page_count=receipt['page_count'],user_unit=receipt['user_unit']),output
