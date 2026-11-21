import { useEffect, useRef, useState } from "react";
import { errorMessage, HostConnectionError } from "../../api/host";
import { PlatformClient } from "../../api/platform";
import { ProjectActionClient } from "../../api/projectActions";
import type { AssistantEvidenceItem } from "../../api/production";
import { StudioIcon } from "../../components/StudioIcons";
import { cameraPresentation } from "../media/cameraPresentation";
import { evidenceLocation } from "../production/evidenceLocation";
import { playEvidenceSource, resolveEvidenceSource, type ResolvedEvidenceSource } from "../production/evidenceSource";
import { evidenceTitle } from "./assistantMarkdown";
import { evidenceTimeRange } from "./assistantPresentation";
import { useAssistantCopy } from "./useAssistantConversation";

interface Props {
  baseUrl: string;
  projectId: string;
  row: AssistantEvidenceItem;
  onClose: () => void;
  onPlaying: (playing: boolean) => void;
  onFocusTake: (groupId: string, destination: "material", clipId?: string) => void;
}

const MISSING_ORIGINAL = "本机暂未绑定原片，请在镜序检查本机素材。";

export function XiaoJingMonitor({ baseUrl, projectId, row, onClose, onPlaying, onFocusTake }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const active = useRef(false);
  const [source, setSource] = useState<ResolvedEvidenceSource | null>(null);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [revealing, setRevealing] = useState(false);
  const { copied, copy } = useAssistantCopy<"time">(() => setNotice("无法复制时间码，请手动复制监看中的原片时间。"));

  useEffect(() => {
    let current = true;
    active.current = true;
    void resolveEvidenceSource(baseUrl, evidenceLocation(projectId, row)).then((next) => {
      if (!current) return;
      if (next) setSource(next);
      else setProblem("这条证据暂无可定位的片段。");
    }).catch((error) => { if (current) setProblem(errorMessage(error)); });
    const pauseWhenHidden = () => {
      if (document.hidden) videoRef.current?.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => {
      current = false;
      active.current = false;
      document.removeEventListener("visibilitychange", pauseWhenHidden);
    };
  }, [baseUrl, projectId, row]);

  function play(video = videoRef.current) {
    if (!video || !source) return;
    if (!playEvidenceSource(video, source)) {
      setProblem("证据时间超出了当前原片时长。");
      onPlaying(false);
    }
  }

  async function revealOriginal() {
    if (revealing) return;
    setRevealing(true);
    setNotice("");
    try {
      const location = await new ProjectActionClient(baseUrl).mediaLocation(projectId, {
        clipId: row.clip_id, mediaId: row.media_id, groupId: row.group_id,
      });
      if (!active.current) return;
      if (location.exists && location.file_path) await new PlatformClient().reveal(location.file_path);
      else setNotice(MISSING_ORIGINAL);
    } catch (error) {
      if (!active.current) return;
      setNotice(error instanceof HostConnectionError && error.status === 404
        ? MISSING_ORIGINAL : "无法显示原片，请在镜序检查本机素材。");
    } finally {
      if (active.current) setRevealing(false);
    }
  }

  const { metadata, group_id: groupId, clip_id: clipId, snippet } = row;
  const title = evidenceTitle(row);
  const camera = metadata?.camera ? cameraPresentation(metadata.camera) : undefined;
  const fileName = (metadata?.file_name || source?.name || title).split(/[\\/]/).pop() || title;
  const time = source ? evidenceTimeRange(source.start, source.end) : "";

  return <section className="xj-monitor" id="xj-inline-monitor" aria-label="证据监看">
    <div className="xj-monitor-content">
      <div className="xj-monitor-frame">
        {source && !problem ? <video ref={videoRef} src={source.url} controls playsInline preload="auto"
          aria-label="原片片段"
          onLoadedMetadata={(event) => play(event.currentTarget)}
          onPlaying={() => onPlaying(true)}
          onPause={() => onPlaying(false)}
          onEnded={() => onPlaying(false)}
          onTimeUpdate={(event) => {
            const video = event.currentTarget;
            if (source.end !== undefined && !video.paused && video.currentTime >= source.end) video.pause();
          }}
          onError={() => {
            onPlaying(false);
            setProblem("无法播放原片，请检查本机素材连接。");
          }} /> : <p role={problem ? "alert" : "status"}>{problem || "正在定位原片…"}</p>}
      </div>
      <div className="xj-monitor-meta">
        <div className="xj-monitor-title">
          <strong title={fileName}>{title}</strong>
          {camera && <span className="xj-camera" data-camera-tone={camera.tone}>{camera.label}</span>}
          {metadata?.shot_type_label && <span className="xj-badge">{metadata.shot_type_label}</span>}
          {time && <span className="xj-time" title="原片时间">原片 <time>{time}</time></span>}
        </div>
        {snippet && <p className="xj-monitor-snippet" title={snippet}>“{snippet}”</p>}
        <div className="xj-monitor-actions">
          <button type="button" disabled={!source || Boolean(problem)} onClick={() => play()}>
            <StudioIcon name="refresh" size={13} /> 重播
          </button>
          <button type="button" disabled={!source} onClick={() => {
            setNotice("");
            void copy("time", [fileName, time, snippet].filter(Boolean).join(" · "));
          }}>{copied ? "已复制" : "复制时间码"}</button>
          <button type="button" disabled={revealing} onClick={() => void revealOriginal()}>
            {revealing ? "正在定位…" : "Finder 显示"}
          </button>
          <button type="button" disabled={!groupId} title={groupId ? undefined : "这条证据未关联 Take"}
            onClick={() => { if (groupId) onFocusTake(groupId, "material", clipId); }}>主窗定位</button>
          <button type="button" className="xj-icon-button xj-monitor-close" aria-label="收起监看" title="收起监看 · Esc" onClick={onClose}>
            <StudioIcon name="close" size={15} />
          </button>
        </div>
        {notice && <p className="xj-monitor-notice" role="status">{notice}</p>}
      </div>
    </div>
  </section>;
}
