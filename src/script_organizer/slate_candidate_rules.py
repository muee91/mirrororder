"""Read-only alignment aid, not edit/assignment authority."""
import re

_RX={'scene':r'[1-9][0-9]*[-－][1-9][0-9]*','shot':r'0*[1-9][0-9]*','take':r'0*[1-9][0-9]*'}
# A note about a source spanning multiple Takes does not make the written count unreadable.
_FLAGS={'scene':r'场号|场次|连拍','shot':r'镜号|镜次','take':r'拍摄次数|次数|重拍|条次|(?<!多个)take'}

def literal_fields(row):
    out={}
    for field,pattern in _RX.items():
        raw=str(row.get(field+'_raw','') or '').strip()
        if re.fullmatch(pattern,raw) and not any(re.search(_FLAGS[field],str(note),re.I) for note in row.get('uncertainties',[])):
            out[field]=raw.replace('－','-')
    return out

def matching_groups(codes,header,keymap):
    if not codes:return []
    return [group for group, entries in keymap.items()
        if all(sum(camera==c and code==v and (not header.get(c) or header[c]==card)
            for camera,_,card,code in entries)==1 for c,v in codes.items())]

def document_locator(row,sha,document_sha,page_count):
    page,ordinal=row.get('pdf_page'),row.get('row_index')
    if document_sha!=sha or type(page) is not int or not 1<=page<=page_count or type(ordinal) is not int or ordinal<=0:return None
    return {'pdf_sha256':sha,'pdf_page':page,'row_index':ordinal}
