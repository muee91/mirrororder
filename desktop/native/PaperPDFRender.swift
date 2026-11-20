// Internal, fixed app-bundled one-shot helper. Caller owns picker grants and deadlines.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
import Darwin
struct Failure: Error { let code: String }
func require(_ value: Bool,_ code:String) throws { if !value { throw Failure(code:code) } }
func digest(_ d:Data)->String {SHA256.hash(data:d).map{String(format:"%02x",$0)}.joined()}
struct Request: Decodable {let pdf_path:String;let expected_pdf_sha256:String;let page_index:Int;let output_png:String;let selection_id:String}
func matrix(_ t:CGAffineTransform)->[Double] {[t.a,t.c,t.tx,t.b,t.d,t.ty,0,0,1].map{Double($0)}}
func respond(_ obj:[String:Any]) { if let data=try? JSONSerialization.data(withJSONObject:obj,options:[.sortedKeys]) {FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]))} }
func run() throws {
 let raw=FileHandle.standardInput.readData(ofLength:16385);try require(raw.count<=16384,"request_too_large")
 let object=try JSONSerialization.jsonObject(with:raw);guard let fields=object as? [String:Any] else {throw Failure(code:"invalid_request")}
 try require(Set(fields.keys)==Set(["pdf_path","expected_pdf_sha256","page_index","output_png","selection_id"]),"invalid_fields")
 let req=try JSONDecoder().decode(Request.self,from:raw)
 try require(req.selection_id.count>=16 && req.selection_id.count<=128,"invalid_selection_id")
 try require(req.pdf_path.hasPrefix("/") && req.output_png.hasPrefix("/") && req.output_png.hasSuffix(".png"),"invalid_internal_path")
 try require(req.expected_pdf_sha256.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,"invalid_expected_digest")
 let fd=open(req.pdf_path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);try require(fd>=0,"source_open_failed");defer{close(fd)}
 var before=stat();try require(fstat(fd,&before)==0 && before.st_mode & S_IFMT == S_IFREG,"source_not_regular")
 try require(before.st_size>0 && before.st_size<=32*1024*1024,"source_size_budget")
 var data=Data();let buffer=UnsafeMutablePointer<UInt8>.allocate(capacity:65536);defer{buffer.deallocate()}
 while true {let n=read(fd,buffer,65536);try require(n>=0,"source_read_failed");if n==0{break};data.append(buffer,count:n);try require(data.count<=32*1024*1024,"source_size_budget")}
 var after=stat();try require(fstat(fd,&after)==0 && before.st_size==after.st_size && before.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec && before.st_ctimespec.tv_sec==after.st_ctimespec.tv_sec && before.st_ctimespec.tv_nsec==after.st_ctimespec.tv_nsec,"source_changed")
 let hash=digest(data);try require(hash==req.expected_pdf_sha256,"selection_digest_changed")
 guard let provider=CGDataProvider(data:data as CFData),let document=CGPDFDocument(provider) else {throw Failure(code:"invalid_pdf")}
 try require(!document.isEncrypted,"encrypted_pdf_unsupported")
 let count=document.numberOfPages;try require(count>0 && count<=500,"page_count_budget");try require(req.page_index>=0 && req.page_index<count,"page_out_of_bounds")
 guard let page=document.page(at:req.page_index+1),let dictionary=page.dictionary else {throw Failure(code:"page_unavailable")}
 var unit:CGPDFReal=1;var objectUnit:CGPDFObjectRef?=nil
 let present=CGPDFDictionaryGetObject(dictionary,"UserUnit",&objectUnit)
 if present {try require(CGPDFDictionaryGetNumber(dictionary,"UserUnit",&unit),"userunit_malformed")}
 try require(unit.isFinite && unit==1,"userunit_unsupported")
 // UserUnit is a page entry, not an inheritable page-tree attribute. Reject ambiguous trees.
 var current=dictionary;var parent:CGPDFDictionaryRef?=nil;var depth=0
 while CGPDFDictionaryGetDictionary(current,"Parent",&parent),let next=parent {depth+=1;try require(depth<=32,"page_tree_budget");var v:CGPDFObjectRef?=nil;try require(!CGPDFDictionaryGetObject(next,"UserUnit",&v),"ambiguous_parent_userunit");current=next;parent=nil}
 let crop=page.getBoxRect(.cropBox),media=page.getBoxRect(.mediaBox);let rotation=page.rotationAngle
 try require([crop.minX,crop.minY,crop.maxX,crop.maxY,media.minX,media.minY,media.maxX,media.maxY].allSatisfy{$0.isFinite},"nonfinite_box")
 try require(crop.width>0 && crop.height>0 && media.contains(crop) && [0,90,180,270].contains(rotation),"unsupported_geometry")
 let pw=rotation%180==0 ? crop.width:crop.height;let ph=rotation%180==0 ? crop.height:crop.width
 let scale=min(2.0,1400.0/pw);let wd=(pw*scale).rounded(),hd=(ph*scale).rounded()
 try require(wd>=1 && hd>=1 && wd<=4096 && hd<=8192 && wd*hd<=8_000_000,"raster_budget")
 let w=Int(wd),h=Int(hd)
 guard let ctx=CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:w*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw Failure(code:"raster_allocation_failed")}
 ctx.setFillColor(CGColor(gray:1,alpha:1));ctx.fill(CGRect(x:0,y:0,width:w,height:h));ctx.concatenate(page.getDrawingTransform(.cropBox,rect:CGRect(x:0,y:0,width:w,height:h),rotate:0,preserveAspectRatio:true))
 let t=ctx.ctm;let map=CGAffineTransform(a:t.a,b:-t.b,c:t.c,d:-t.d,tx:t.tx,ty:CGFloat(h)-t.ty)
 try require(matrix(map).allSatisfy{$0.isFinite} && abs(map.a*map.d-map.b*map.c)>1e-12,"singular_transform")
 ctx.drawPDFPage(page);guard let image=ctx.makeImage() else {throw Failure(code:"render_failed")}
 let png=NSMutableData();guard let destination=CGImageDestinationCreateWithData(png,UTType.png.identifier as CFString,1,nil) else {throw Failure(code:"png_failed")}
 CGImageDestinationAddImage(destination,image,nil);try require(CGImageDestinationFinalize(destination),"png_failed")
 let bytes=png as Data;try require(bytes.count<=32*1024*1024,"png_budget")
 // Output is a caller-private cache path, never an original. Exclusive create forbids overwrite.
 let out=open(req.output_png,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0o600);try require(out>=0,"output_exists_or_unavailable")
 var written=0;var okay=true
 bytes.withUnsafeBytes {p in while written<bytes.count {let n=write(out,p.baseAddress!.advanced(by:written),bytes.count-written);if n<=0 {okay=false;break};written+=n}}
 let syncOkay=fsync(out)==0;close(out);if !okay || !syncOkay {unlink(req.output_png);throw Failure(code:"output_write_failed")}
 respond(["schema":"mirrororder.native_pdf_render.v1","status":"rendered","selection_id":req.selection_id,"document_sha256":hash,"page_index":req.page_index,"page_count":count,"user_unit":Double(unit),"user_unit_source":present ? "page_dictionary":"pdf_default_absent_page_entry","rotation":rotation,"crop_box":[crop.minX,crop.minY,crop.maxX,crop.maxY],"raster_size":[w,h],"raster_sha256":digest(bytes),"pdf_to_pixel":matrix(map),"pixel_to_pdf":matrix(map.inverted()),"renderer":"Apple CoreGraphics","authority":false,"ocr_performed":false])
}
// A malicious or corrupt parser stall is bounded independently of the caller.
DispatchQueue.global().asyncAfter(deadline:.now()+20){_exit(124)}
do {try run()} catch let error as Failure {respond(["status":"blocked","error":error.code]);exit(2)} catch {respond(["status":"blocked","error":"invalid_request_or_render_failure"]);exit(2)}
