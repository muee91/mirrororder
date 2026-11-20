import {useLayoutEffect,useRef,useState,type CSSProperties} from "react";
import "./slate-original-playback.css";
import {HostConnection} from "../../api/host";

type Source={clipId:string;mediaId:string}&({assetRevision:string;selectionKey?:never}|{assetRevision?:never;selectionKey:string});
export function originalPlaybackUrl(baseUrl:string,projectId:string,source:Source,registeredOnly=false):string|null {
  try {
    const base=new URL(baseUrl);
    if(base.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(base.hostname)
      ||base.username||base.password||base.search||base.hash||base.pathname!=="/"||!projectId.trim()
      ||!source.clipId.trim()||!(source.assetRevision??source.selectionKey).trim()||!/^M_[0-9a-f]{24}$/.test(source.mediaId))return null;
    const playback=new URL(new HostConnection(base.origin).mediaUrl(projectId,source.clipId));
    playback.searchParams.set("expected_media_id",source.mediaId);
    if(registeredOnly)playback.searchParams.set("slate_registered_source","1");
    return playback.href;
  }catch{return null;}
}

/** Visual reference only: decoded playback time never writes source-frame evidence. */
export function SlateOriginalPlayback({baseUrl,projectId,source,startOpen=false,playOnSelect=false,registeredOnly=false}:{baseUrl:string;projectId:string;source:Source;startOpen?:boolean;playOnSelect?:boolean;registeredOnly?:boolean}){
  const url=originalPlaybackUrl(baseUrl,projectId,source,registeredOnly);
  const identity=JSON.stringify([url,source.assetRevision??source.selectionKey]);
  const [openedFor,setOpenedFor]=useState(()=>startOpen?identity:""),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0),[canPlay,setCanPlay]=useState(false);
  const player=useRef<HTMLVideoElement>(null);
  const renderKey=JSON.stringify([identity,retry]);
  const [shape,setShape]=useState<{key:string;width:number;height:number}>();
  const frame=shape?.key===renderKey?shape:undefined;
  const measure=(video:HTMLVideoElement)=>{
    if(video!==player.current)return;
    const width=video.videoWidth,height=video.videoHeight;
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1)return;
    setShape(prev=>prev?.key===renderKey&&prev.width===width&&prev.height===height?prev:{key:renderKey,width,height});
  };

  const open=openedFor===identity;
  useLayoutEffect(()=>{
    if(playOnSelect&&open&&player.current){const p=player.current.play();p?.catch(()=>{});}
  },[identity,playOnSelect,open,retry]);
  if(!url)return null;
  return <div className="sil-original-playback">
    <button type="button" aria-expanded={open} onClick={()=>{setOpenedFor(open?"":identity);setFailed(false);setCanPlay(false);}}>{open?"关闭原片":"查看原片"}</button>
    {open&&<>
      {failed?<p role="status">这条原片现在无法播放。可能是文件离线、已变化或格式暂不支持；请核对素材连接。</p>:
        <video ref={player} aria-label="原片参考播放" key={renderKey} className="sil-oriented-video"
          data-frame={frame?"ready":"loading"} data-orientation={frame?(frame.height>frame.width?"portrait":"landscape"):undefined}
          style={frame?{"--slate-display-ratio":frame.width/frame.height} as CSSProperties:undefined}
          src={url} preload={startOpen?"none":"metadata"} controls playsInline
          onLoadedMetadata={e=>measure(e.currentTarget)} onResize={e=>measure(e.currentTarget)}
          onCanPlay={e=>{measure(e.currentTarget);setCanPlay(true);}}
          onError={()=>{setCanPlay(false);setFailed(true);}}/>}
      {!failed&&!frame&&<small role="status">正在读取原片画幅…</small>}
      {failed&&<button type="button" onClick={()=>{setRetry(i=>i+1);setFailed(false);}}>重试播放</button>}
      {canPlay&&<small role="status">可播放</small>}
      <small>只用于看片。播放位置不会换算或改写场记帧位。</small>
    </>}
  </div>;
}
