"""Rec-only reference for an INTERNAL verified model path. Not an IPC path API.
No downloader or detector. Results are proposals, not editable paper authority.
"""
import hashlib
from pathlib import Path
MODEL_SHA256='5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5'
class CPURecognizer:
 def __init__(self, verified_internal_model_path):
  import onnx,onnxruntime as ort
  p=Path(verified_internal_model_path)
  if not p.is_file() or p.stat().st_size>32*1024*1024:raise ValueError('model_unavailable')
  if hashlib.sha256(p.read_bytes()).hexdigest()!=MODEL_SHA256:raise ValueError('model_mismatch')
  m=onnx.load(p,load_external_data=False)
  if any(t.data_location==1 for t in m.graph.initializer) or any(n.domain!='' for n in m.graph.node):raise ValueError('unexpected_model_contract')
  chars={v.key:v.value for v in m.metadata_props}['character'].splitlines()
  if len(chars)!=18383:raise ValueError('dictionary_mismatch')
  self.vocab=['blank']+chars+[' ']
  ort.disable_telemetry_events();o=ort.SessionOptions();o.intra_op_num_threads=2;o.inter_op_num_threads=1
  self.session=ort.InferenceSession(str(p),sess_options=o,providers=['CPUExecutionProvider']);self.session.disable_fallback()
  if self.session.get_providers()!=['CPUExecutionProvider']:raise ValueError('provider_mismatch')
 def recognize(self,rgb):
  import numpy as np,cv2
  if rgb.ndim!=3 or rgb.shape[2]!=3 or min(rgb.shape[:2])<1 or rgb.shape[0]*rgb.shape[1]>1000000:raise ValueError('crop_bounds')
  h,w=rgb.shape[:2];rw=int(np.ceil(48*w/h));cw=max(320,rw)
  if cw>4096:raise ValueError('crop_aspect')
  a=cv2.resize(rgb[:,:,::-1],(rw,48)).astype('float32').transpose(2,0,1)/255.;a=(a-.5)/.5;x=np.zeros((1,3,48,cw),dtype='float32');x[0,:,:,:rw]=a
  probs=self.session.run(None,{self.session.get_inputs()[0].name:x})[0]
  if probs.shape[-1]!=len(self.vocab):raise ValueError('output_contract')
  ids=probs.argmax(axis=2)[0];scores=probs.max(axis=2)[0];keep=[i for i,v in enumerate(ids) if v!=0 and (i==0 or v!=ids[i-1])]
  return {'text':''.join(self.vocab[int(ids[i])] for i in keep),'score':float(np.mean(scores[keep])) if keep else 0.,'status':'proposal','review_required':True,'editorial_authority':False,'model_sha256':MODEL_SHA256}
