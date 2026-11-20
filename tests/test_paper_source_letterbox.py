import json
from pathlib import Path
import pytest
from script_organizer.paper_source_binding import canonical_native,validate_render_canvas,make_geometry
FIX=Path(__file__).parent/'fixtures/paper-native/native-output/receipts.json'

@pytest.mark.parametrize('rotation',[0,90,180,270])
def test_native_rotations_with_canvas_margins(rotation):
    native=next(r for r in json.loads(FIX.read_text()) if r['rotation']==rotation)
    # Add a real canvas-margin translation, not an artificial paper expansion.
    m=native['pdf_to_pixel'];m[2]+=40;m[5]+=80
    a,b,c,d,e,f,g,h,i=m;det=a*e-b*d
    native['pixel_to_pdf']=[e/det,-b/det,(b*f-e*c)/det,-d/det,a/det,(d*c-a*f)/det,0,0,1]
    native['raster_size']=[native['raster_size'][0]+80,native['raster_size'][1]+160]
    receipt=canonical_native(native,page_count=1,user_unit=1)
    assert len(validate_render_canvas(receipt))==4
    with pytest.raises(ValueError,match='outside_pdf_cropbox'):
        make_geometry(receipt,[[0,0],[5,0],[5,5],[0,5]])

def test_reported_coregraphics_90_centered_actual_matrix():
    native=next(r for r in json.loads(FIX.read_text()) if r['rotation']==90)
    native.update(pdf_to_pixel=[0,1,30,1,0,90,0,0,1],pixel_to_pdf=[0,1,-90,1,0,-30,0,0,1],raster_size=[200,400],raster_sha256='895895482899eecdc7a1e90de4cf4ff6886866f38cfc698a5c15762e4984e7e3')
    receipt=canonical_native(native,page_count=1,user_unit=1)
    assert set(map(tuple,validate_render_canvas(receipt)))=={('50','100'),('50','300'),('150','100'),('150','300')}
    with pytest.raises(ValueError,match='outside_pdf_cropbox'):make_geometry(receipt,[[0,0],[200,0],[200,400],[0,400]])
    assert set(map(tuple,make_geometry(receipt,[[70,120],[90,120],[90,140],[70,140]])))=={('30','40'),('30','60'),('50','40'),('50','60')}

@pytest.mark.parametrize('invalid',['canvas','matrix','unit','crop'])
def test_out_of_canvas_or_tampered_receipt_rejected(invalid):
    native=json.loads(FIX.read_text())[0];receipt=canonical_native(native,page_count=1,user_unit=1)
    if invalid=='canvas':receipt['render_map']['width']=5
    if invalid=='matrix':receipt['render_map']['pixel_to_pdf']=[0]*9
    if invalid=='unit':receipt['user_unit']='2'
    if invalid=='crop':receipt['cropbox']=['10','20','9','120']
    with pytest.raises(ValueError):validate_render_canvas(receipt)
