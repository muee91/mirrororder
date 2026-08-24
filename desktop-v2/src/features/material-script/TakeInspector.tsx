import { useMemo } from "react";
import type { HostConnection, ReviewTakeGroup } from "../../api/host";
import { episodeLabel, mappingLabel, mappingSourceLabel } from "./VirtualTakeList";

export function TakeInspector({
  connection,
  projectId,
  take,
  selectedClipId,
  onSelectClip,
  onShowScript,
  onClearPlacement,
  writeSaving,
}: {
  connection: HostConnection;
  projectId: string;
  take: ReviewTakeGroup | null;
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
  onShowScript: () => void;
  onClearPlacement: () => void;
  writeSaving: boolean;
}) {
  const angle = take?.angles.find((item) => item.clip_id === selectedClipId) ?? take?.angles[0] ?? null;
  const playbackUrl = useMemo(
    () => angle ? connection.mediaUrl(projectId, angle.clip_id) : "",
    [angle, connection, projectId],
  );

  if (!take) return <aside className="take-inspector"><div className="player-empty">当前项目没有 Take。</div></aside>;

  return (
    <aside className="take-inspector">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">当前 Take</p>
          <h3>{take.group_id}</h3>
        </div>
        <span className={`mapping-source source-${take.effective_mapping.source}`}>
          {mappingSourceLabel(take.effective_mapping.source)}
        </span>
      </div>
      <p className="inspector-mapping">{mappingLabel(take)}</p>
      <div className="inspector-actions">
        <button type="button" className="secondary" onClick={onShowScript}>定位剧本</button>
        {take.effective_mapping.source === "human" ? (
          <button type="button" className="secondary danger-quiet" disabled={writeSaving} onClick={onClearPlacement}>
            清除人工归集
          </button>
        ) : null}
      </div>

      <div className="inspector-angle-tabs">
        {take.angles.map((item) => (
          <button
            type="button"
            className={item.clip_id === angle?.clip_id ? "is-active" : ""}
            key={item.clip_id}
            onClick={() => onSelectClip(item.clip_id)}
          >
            {item.camera || "—"}{item.shot_type && item.shot_type !== "unknown" ? ` · ${item.shot_type}` : ""}
          </button>
        ))}
      </div>

      {angle?.playback.available === false ? (
        <div className="player-empty">当前设备未解析到这条媒体。</div>
      ) : angle && playbackUrl ? (
        <video
          className="take-player"
          controls
          preload="metadata"
          src={playbackUrl}
          key={angle.clip_id}
          onLoadedMetadata={(event) => {
            if (angle.source_start > 0) event.currentTarget.currentTime = angle.source_start;
          }}
          onTimeUpdate={(event) => {
            if (event.currentTarget.currentTime < angle.source_start) event.currentTarget.currentTime = angle.source_start;
            if (angle.source_end !== null && event.currentTarget.currentTime >= angle.source_end) event.currentTarget.pause();
          }}
        />
      ) : (
        <div className="player-empty">当前 Take 没有可播放机位。</div>
      )}

      {angle ? (
        <div className="selected-angle-meta">
          <strong>{angle.name}</strong>
          <span>{angle.camera || "—"} · {angle.duration.toFixed(1)}s · {angle.shot_type && angle.shot_type !== "unknown" ? angle.shot_type : "景别尚无 clip-level 投影"}</span>
        </div>
      ) : null}

      <div className="dialogue-panel">
        <p className="eyebrow">对白 / 证据</p>
        <p>{take.transcript.text || "当前没有可靠对白投影。"}</p>
      </div>

      {take.candidates.length > 0 ? (
        <div className="candidate-panel">
          <p className="eyebrow">候选，不是人工权威</p>
          {take.candidates.slice(0, 3).map((candidate) => (
            <div className="candidate-row" key={candidate.candidate_id}>
              <span>{candidate.episode_ids.map(episodeLabel).join("/") || "未分集"}</span>
              <strong>{candidate.script_segment_ids.join(", ") || candidate.script_segment_id || "—"}</strong>
              <code>{candidate.total_score.toFixed(3)}</code>
            </div>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
