import { useEffect, useMemo, useState } from "react";
import {
  HostConnection,
  HostConnectionError,
  type ProjectSummary,
  type ReviewEpisode,
  type ReviewModelPayload,
  type ReviewTakeGroup,
} from "../../api/host";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
}

type WorkbenchTab = "material" | "script";
type LoadState = "loading" | "ready" | "error";

const TAKE_PAGE_SIZE = 60;

function loadErrorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function episodeLabel(episode: number): string {
  return episode > 0 ? `EP${episode}` : "未分集";
}

function mappingLabel(take: ReviewTakeGroup): string {
  const mapping = take.effective_mapping;
  if (mapping.mapping_status === "episode_only") {
    return mapping.episode_ids.length > 0
      ? `仅归集到 ${mapping.episode_ids.map(episodeLabel).join(" / ")}`
      : "仅完成集数归集";
  }
  if (mapping.script_segment_ids.length > 0) {
    const episodes = mapping.episode_ids.map(episodeLabel).join(" / ");
    return `${episodes ? `${episodes} · ` : ""}${mapping.script_segment_ids.length} 个剧本段`;
  }
  return "未归集";
}

function mappingSourceLabel(source: string): string {
  if (source === "human") return "人工";
  if (source === "automatic") return "自动";
  return "待处理";
}

function TakeCard({ take, selected, onSelect }: { take: ReviewTakeGroup; selected: boolean; onSelect: () => void }) {
  return (
    <article className={`take-card ${selected ? "is-selected" : ""}`}>
      <header className="take-card-heading">
        <div>
          <div className="take-title-row">
            <strong>{take.group_id}</strong>
            {take.take_index > 1 ? <span className="tiny-pill">#{take.take_index}</span> : null}
            <span className={`mapping-source source-${take.effective_mapping.source}`}>
              {mappingSourceLabel(take.effective_mapping.source)}
            </span>
          </div>
          <p>{mappingLabel(take)}</p>
        </div>
        <div className="take-heading-actions">
          <span className="duration-label">{take.duration.toFixed(1)}s</span>
          <button type="button" className="take-select" onClick={onSelect}>{selected ? "当前" : "查看"}</button>
        </div>
      </header>

      {take.transcript.text ? <p className="take-transcript">{take.transcript.text}</p> : null}

      <div className="angle-strip" aria-label={`${take.group_id} 机位`}>
        {take.angles.map((angle) => (
          <div className="angle-card" key={angle.clip_id}>
            <div className="angle-card-heading">
              <span className="camera-label">{angle.camera || "—"}</span>
              <span>{angle.duration.toFixed(1)}s</span>
            </div>
            <strong title={angle.name}>{angle.name}</strong>
            <div className="angle-meta">
              <span>{angle.playback.available === false ? "缺媒体" : "可播放"}</span>
              {angle.media_id ? <code>{angle.media_id}</code> : null}
            </div>
          </div>
        ))}
      </div>

      {take.issues.length > 0 ? (
        <div className="issue-row">
          {take.issues.map((issue) => (
            <span className={`issue-chip issue-${issue.severity}`} key={`${take.group_id}-${issue.code}`}>
              {issue.label}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function EpisodeScript({ episode }: { episode: ReviewEpisode }) {
  return (
    <div className="script-episode">
      {episode.scenes.map((scene) => (
        <section className="script-scene" key={scene.scene_id}>
          <header>
            <div>
              <p className="eyebrow">{scene.scene_id}</p>
              <h3>{scene.heading || "未命名场"}</h3>
            </div>
            <span className="count-pill">{scene.take_group_ids.length} Take</span>
          </header>
          <div className="script-block-list">
            {scene.script_blocks.map((block) => (
              <article className={`script-block block-${block.type || "unknown"}`} key={block.segment_id}>
                <div className="script-block-meta">
                  <span>{block.speaker || block.type || "剧本"}</span>
                  <code>{block.segment_id}</code>
                </div>
                <p>{block.raw_text || block.text || "—"}</p>
                {block.issues.length > 0 ? (
                  <div className="issue-row">
                    {block.issues.map((issue) => (
                      <span className={`issue-chip issue-${issue.severity}`} key={`${block.segment_id}-${issue.code}`}>
                        {issue.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function MaterialScriptWorkbench({ baseUrl, project }: Props) {
  const connection = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const [tab, setTab] = useState<WorkbenchTab>("material");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [model, setModel] = useState<ReviewModelPayload | null>(null);
  const [activeEpisode, setActiveEpisode] = useState<number | null>(null);
  const [visibleTakeCount, setVisibleTakeCount] = useState(TAKE_PAGE_SIZE);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setMessage("正在读取 Python Core 的 review.v1 投影…");
    setModel(null);
    setActiveEpisode(null);
    setVisibleTakeCount(TAKE_PAGE_SIZE);
    setSelectedGroupId(null);
    setSelectedClipId(null);

    void connection
      .reviewModel(project.project_id)
      .then((next) => {
        if (cancelled) return;
        setModel(next);
        const firstTake = next.take_groups[0] ?? null;
        setSelectedGroupId(firstTake?.group_id ?? null);
        setSelectedClipId(firstTake?.angles[0]?.clip_id ?? null);
        setActiveEpisode(next.episodes[0]?.episode ?? null);
        setLoadState("ready");
        setMessage(`review.v1 · analysis ${next.revisions.analysis || "—"} · review r${next.revisions.review}`);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadState("error");
        setMessage(loadErrorMessage(error));
      });

    return () => {
      cancelled = true;
    };
  }, [connection, project.project_id]);

  const selectedEpisode = model?.episodes.find((item) => item.episode === activeEpisode) ?? model?.episodes[0] ?? null;
  const visibleTakes = model?.take_groups.slice(0, visibleTakeCount) ?? [];
  const selectedTake = model?.take_groups.find((item) => item.group_id === selectedGroupId) ?? model?.take_groups[0] ?? null;
  const selectedAngle = selectedTake?.angles.find((item) => item.clip_id === selectedClipId) ?? selectedTake?.angles[0] ?? null;
  const playbackUrl = selectedAngle?.playback.url ? new URL(selectedAngle.playback.url, `${baseUrl}/`).toString() : "";

  function selectTake(take: ReviewTakeGroup): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
  }

  return (
    <section className="material-script-workbench">
      <div className="workbench-heading phase2-heading">
        <div>
          <p className="eyebrow">项目</p>
          <h2>{project.name || project.project_id}</h2>
        </div>
        <div className="workbench-revision">
          <code>{project.project_id}</code>
          {model ? <span>{model.take_groups.length} Take · {model.episodes.length} 集</span> : null}
        </div>
      </div>

      <nav className="workbench-tabs" aria-label="素材剧本工作台">
        <button type="button" className={tab === "material" ? "is-active" : ""} onClick={() => setTab("material")}>
          素材
        </button>
        <button type="button" className={tab === "script" ? "is-active" : ""} onClick={() => setTab("script")}>
          剧本
        </button>
      </nav>

      <div className={`projection-status ${loadState === "error" ? "is-error" : ""}`}>
        <span className={`status-dot status-dot-${loadState}`} />
        {message}
      </div>

      {loadState === "loading" ? (
        <div className="phase-placeholder compact-placeholder">读取素材 / 剧本投影…</div>
      ) : loadState === "error" || !model ? (
        <div className="phase-placeholder compact-placeholder">
          <strong>review-model 暂不可用</strong>
          <p>{message}</p>
        </div>
      ) : tab === "material" ? (
        <div className="take-workbench">
          <div className="projection-summary">
            <span>Take {model.summary.take_groups}</span>
            <span>剧本缺口 {model.summary.script_gaps}</span>
            <span>自动状态由 Host 提供</span>
            <span>人工 placement 优先</span>
          </div>
          <div className="material-layout">
            <div>
              <div className="take-list">
                {visibleTakes.map((take) => (
                  <TakeCard
                    key={take.group_id}
                    take={take}
                    selected={take.group_id === selectedTake?.group_id}
                    onSelect={() => selectTake(take)}
                  />
                ))}
              </div>
              {visibleTakeCount < model.take_groups.length ? (
                <button className="load-more" type="button" onClick={() => setVisibleTakeCount((value) => value + TAKE_PAGE_SIZE)}>
                  再显示 {Math.min(TAKE_PAGE_SIZE, model.take_groups.length - visibleTakeCount)} 个 Take
                </button>
              ) : null}
            </div>

            <aside className="take-inspector">
              {selectedTake ? (
                <>
                  <div className="inspector-heading">
                    <div>
                      <p className="eyebrow">当前 Take</p>
                      <h3>{selectedTake.group_id}</h3>
                    </div>
                    <span className={`mapping-source source-${selectedTake.effective_mapping.source}`}>
                      {mappingSourceLabel(selectedTake.effective_mapping.source)}
                    </span>
                  </div>
                  <p className="inspector-mapping">{mappingLabel(selectedTake)}</p>
                  <div className="inspector-angle-tabs">
                    {selectedTake.angles.map((angle) => (
                      <button
                        type="button"
                        className={angle.clip_id === selectedAngle?.clip_id ? "is-active" : ""}
                        key={angle.clip_id}
                        onClick={() => setSelectedClipId(angle.clip_id)}
                      >
                        {angle.camera || "—"}
                      </button>
                    ))}
                  </div>
                  {selectedAngle?.playback.available === false ? (
                    <div className="player-empty">当前设备未解析到这条媒体。</div>
                  ) : selectedAngle && playbackUrl ? (
                    <video
                      className="take-player"
                      controls
                      preload="metadata"
                      src={playbackUrl}
                      onLoadedMetadata={(event) => {
                        if (selectedAngle.source_start > 0) event.currentTarget.currentTime = selectedAngle.source_start;
                      }}
                      onTimeUpdate={(event) => {
                        if (selectedAngle.source_end !== null && event.currentTarget.currentTime >= selectedAngle.source_end) {
                          event.currentTarget.pause();
                        }
                      }}
                    />
                  ) : (
                    <div className="player-empty">当前 Take 没有可播放机位。</div>
                  )}
                  {selectedAngle ? (
                    <div className="selected-angle-meta">
                      <strong>{selectedAngle.name}</strong>
                      <span>{selectedAngle.camera || "—"} · {selectedAngle.duration.toFixed(1)}s</span>
                    </div>
                  ) : null}
                  <div className="dialogue-panel">
                    <p className="eyebrow">对白 / 证据</p>
                    <p>{selectedTake.transcript.text || "当前没有可靠对白投影。"}</p>
                  </div>
                </>
              ) : (
                <div className="player-empty">当前项目没有 Take。</div>
              )}
            </aside>
          </div>
        </div>
      ) : (
        <div className="script-workbench">
          <div className="episode-strip" aria-label="剧本集数">
            {model.episodes.map((episode) => (
              <button
                type="button"
                className={episode.episode === selectedEpisode?.episode ? "is-active" : ""}
                key={episode.episode}
                onClick={() => setActiveEpisode(episode.episode)}
              >
                {episodeLabel(episode.episode)}
              </button>
            ))}
          </div>
          {selectedEpisode ? <EpisodeScript episode={selectedEpisode} /> : <p className="empty-copy">当前项目没有剧本段。</p>}
        </div>
      )}
    </section>
  );
}
