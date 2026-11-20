"""One bounded offline CPU page worker. Internal file arguments only."""
import hashlib,json,os,signal,socket,sys,time
from pathlib import Path

def main():
    if len(sys.argv) not in (5,6):raise ValueError('worker_arguments')
    packages,model,png,result=sys.argv[1:5]
    region=json.loads(sys.argv[5]) if len(sys.argv)==6 else None
    sys.path.insert(0,packages)
    sys.path.insert(0,str(Path(__file__).resolve().parent))
    signal.alarm(24) # bounded even if the supervising private consumer dies
    def denied(*a,**k):raise RuntimeError('network_disabled_in_python_worker')
    socket.create_connection=denied
    socket.socket.connect=denied
    import cv2,numpy as np,onnx,onnxruntime
    if (onnxruntime.__version__,onnx.__version__,np.__version__,cv2.__version__)!=('1.25.1','1.23.2','2.4.3','4.13.0'):raise ValueError('runtime_version_mismatch')
    from paper_grid_geometry import detect
    from paper_rec_profile import CPURecognizer,MODEL_SHA256
    from paper_ocr_geometry import cells_from_lines,guard_manual_region
    raw=Path(png).read_bytes()
    if len(raw)>8*1024*1024:raise ValueError('raster_byte_budget')
    im=cv2.imread(png)
    if im is None or im.shape[0]*im.shape[1]>8_000_000:raise ValueError('raster_pixel_budget')
    detection_png=png
    if region is not None:
        if not isinstance(region,dict) or set(region)!={'pixel_rect','mode'} or region['mode']!='manual_body_region':raise ValueError('invalid_internal_region')
        box=region['pixel_rect']
        if not isinstance(box,list) or len(box)!=4 or any(type(v) is not int for v in box):raise ValueError('invalid_internal_region')
        x0,y0,x1,y1=box
        if not(0<=x0<x1<=im.shape[1] and 0<=y0<y1<=im.shape[0]):raise ValueError('region_outside_page')
        mask=np.full_like(im,255);mask[y0:y1,x0:x1]=im[y0:y1,x0:x1];im=mask
        detection_png=str(Path(result).with_suffix('.region.png'))
        if not cv2.imwrite(detection_png,mask):raise ValueError('region_image_failed')
    gray=cv2.cvtColor(im,cv2.COLOR_BGR2GRAY)
    def support(a,b):
        n=max(2,int(np.hypot(b[0]-a[0],b[1]-a[1])))
        if n>10000:return 0.
        count=0
        for px,py in zip(np.linspace(a[0],b[0],n),np.linspace(a[1],b[1],n)):
            x,y=int(round(px)),int(round(py))
            if x<0 or y<0 or x>=im.shape[1] or y>=im.shape[0]:return 0.
            local=gray[max(0,y-2):min(im.shape[0],y+3),max(0,x-2):min(im.shape[1],x+3)]
            count+=bool(np.any(local<150))
        return count/n
    try:grid,_=detect(detection_png)
    except ValueError:
        output={'status':'no_grid','reason':'no_supported_rules','cells':[]}
    else:output=cells_from_lines(grid,support)
    if region is not None:output=guard_manual_region(output,region['pixel_rect'])
    ready=[c for c in output['cells'] if c['state']=='geometry_candidate']
    recognizer=None
    for cell in ready:
        p=np.array(cell['pixel_polygon'],np.float32)
        width=int(round(max(np.linalg.norm(p[1]-p[0]),np.linalg.norm(p[2]-p[3]))))
        height=int(round(max(np.linalg.norm(p[3]-p[0]),np.linalg.norm(p[2]-p[1]))))
        if width<8 or height<8 or width*height>1_000_000:
            cell.update(state='ambiguous',reason='crop_budget');continue
        warp=cv2.getPerspectiveTransform(p,np.array([[0,0],[width-1,0],[width-1,height-1],[0,height-1]],np.float32))
        crop=cv2.warpPerspective(im,warp,(width,height),borderMode=cv2.BORDER_CONSTANT,borderValue=(255,255,255))[3:-3,3:-3]
        if recognizer is None:recognizer=CPURecognizer(model)
        item=recognizer.recognize(cv2.cvtColor(crop,cv2.COLOR_BGR2RGB))
        cell.update(state='proposal',text=item['text'],score=item['score'],score_is_probability=False)
    if any(c['state']=='ambiguous' for c in output['cells']):output['status']='ambiguous'
    output['recognized_cell_count']=sum(c['state']=='proposal' for c in output['cells'])
    output.update(schema='mirrororder.paper_ocr_worker.v1',png_sha256=hashlib.sha256(raw).hexdigest(),model_sha256=MODEL_SHA256,
                  engine='ppocrv5-mobile-rec-only',recognition_mode='manual_body_region' if region is not None else 'automatic_full_page',authority=False,review_required=True)
    encoded=json.dumps(output,ensure_ascii=True,allow_nan=False).encode('ascii')
    if len(encoded)>2*1024*1024:raise ValueError('response_budget')
    Path(result).write_bytes(encoded)
if __name__=='__main__':
    main()
