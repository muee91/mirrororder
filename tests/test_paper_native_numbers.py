import json
from fractions import Fraction
from pathlib import Path
import pytest
from script_organizer.paper_source_binding import canonical_native,validate_render_canvas,make_geometry
from script_organizer.paper_geometry import rational
FIX=Path(__file__).parent/'fixtures/paper-native/native-output/receipts.json'

def actual_numeric_receipt():
    r=json.loads(FIX.read_text())[0]
    r.update(crop_box=[0,0,595.2755900000001,841.88976],raster_size=[1191,1684],
        pdf_to_pixel=[1,0,297.86220499999996,0,-1,1262.94488,0,0,1],
        pixel_to_pdf=[1,0,-297.86220499999996,0,-1,1262.94488,0,0,1])
    return r

def test_actual_a4_numeric_snapshot_with_error_witness():
    r=canonical_native(actual_numeric_receipt(),page_count=27,user_unit=1)
    assert len(validate_render_canvas(r))==4
    proof=json.loads(r['render_map']['transform_history'][-1])
    assert proof['decimal_places']==9 and proof['kind']=='native_decimal_canonicalization_v1'
    assert Fraction(proof['max_inverse_error_pt'])<Fraction(1,10**10)
    assert Fraction(proof['max_crop_error_pt'])<Fraction(1,10**10)
    assert r['cropbox'][2]=='59527559/100000'
    assert make_geometry(r,[[400,600],[500,600],[500,700],[400,700]])
    with pytest.raises(ValueError):make_geometry(r,[[0,0],[1,0],[1,1],[0,1]])

@pytest.mark.parametrize('rotation',[0,90,180,270])
def test_existing_short_decimal_native_receipts_unchanged(rotation):
    raw=next(r for r in json.loads(FIX.read_text()) if r['rotation']==rotation)
    converted=canonical_native(raw,page_count=1,user_unit=1)
    assert converted['render_map']['pixel_to_pdf']==[str(Fraction(str(v))) for v in raw['pixel_to_pdf']]
    assert len(converted['render_map']['transform_history'])==1
    assert validate_render_canvas(converted)

def test_user_geometry_limit_not_widened():
    with pytest.raises(ValueError,match='geometry_budget'):rational('297.86220499999996')

def test_native_error_over_budget_and_unknown_types_rejected():
    raw=actual_numeric_receipt();raw['pixel_to_pdf'][2]+=.01
    with pytest.raises(ValueError,match='projection_error'):canonical_native(raw,page_count=27,user_unit=1)
    raw=actual_numeric_receipt();raw['pixel_to_pdf'][2]='297.86220499999996'
    with pytest.raises(ValueError,match='numeric_bounds'):canonical_native(raw,page_count=27,user_unit=1)

def test_synthetic_same_a4_dimensions_pdf_fixture(tmp_path):
    from reportlab.pdfgen import canvas
    from pypdf import PdfReader
    pdf=tmp_path/'a4-numeric.pdf';c=canvas.Canvas(str(pdf),pagesize=(595.2755900000001,841.88976));c.drawString(40,400,'SYNTHETIC 003 02A');c.showPage();c.save()
    page=PdfReader(pdf).pages[0]
    # PDF serialization may use fewer decimal places; it is a synthetic renderer
    # repro input, not proof that cloud executed CoreGraphics on this PDF.
    assert abs(float(page.mediabox.width)-595.2755900000001)<.001
    assert abs(float(page.mediabox.height)-841.88976)<.001
