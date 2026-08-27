import { useEffect, useMemo, useState, type ReactNode } from "react";
import { HostConnectionError } from "../../api/host";
import {
  PlanningClient,
  type AssemblyScene,
  type AssemblyTimeline,
  type CoverageGraph,
  type CoverageScene,
  type RoughCutPlan,
  type RoughCutScene,
  type RoughCutSegment,
} from "../../api/planning";
import "./planning.css";

interface Props {
  baseUrl: string;
  projectId: string;
  onOpenTake?: (groupId: string) => void;
}

type LoadState = "loading" | "ready" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function readinessLabel(value: string): string {
  return {
    ready: "已准备",
    needs_review: "需要处理",
    blocked: "阻塞",
  }[value] ?? (value || "未知");
}

function selectionLabel(value: string): string {
  return {
    explicit_best: "已选 Best",
    needs_editorial_choice: "待最终选择",
    no_eligible_take: "无可用 Take",
    conflict_multiple_best: "多个 Best 冲突",
    conflict_supervisor_vs_best: "Best 与场记 NG 冲突",
  }[value] ?? (value || "待处理");
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function countMap(value: Record<string, number> | undefined): string {
  if (!value) return "—";
  const rows = Object.entries(value).filter(([, count]) => count > 0);
  return rows.length ? rows.map(([label, count]) => `${label} ${count}`).join(" · ") : "—";
}

function EpisodeToolbar({ episodes, value, onChange }: { episodes: number[]; value: number | null; onChange: (episode: number | null) => void }) {
  return (
    <div className="planning-episode-strip" aria-label="集数筛选">
      <button type="button" className={value === null ? "is-active" : ""} onClick={() => onChange(null)}>全部</button>
      {episodes.map((episode) => (
        <button type="button" className={value === episode ? "is-active" : ""} key={episode} onClick={() => onChange(episode)}>EP{episode}</button>
      ))}
    </div>
  );
}

function PlanningHeader({ eyebrow, title, state, action }: { eyebrow: string; title: string; state: string; action?: ReactNode }) {
  return (
    <header className="planning-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <div className="planning-heading-meta">
        <span>{state}</span>
        {action}
      </div>
    </header>
  );
}

function CoverageSceneRow({ scene, onOpenTake }: { scene: CoverageScene; onOpenTake?: (groupId: string) => void }) {
  return (
    <details className={`planning-scene ${scene.issues.some((issue) => issue.severity === "warning") ? "has-attention" : ""}`}>
      <summary>
        <div className="planning-scene-title">
          <strong>{scene.scene_id}</strong>
          <span>{scene.heading || `EP${scene.episode}`}</span>
        </div>
        <div className="planning-scene-metrics">
          <span>{scene.summary.take_groups} Take</span>
          <span>{scene.summary.angles} 机位</span>
          <span>{scene.summary.known_shots}/{scene.summary.angles} 景别有证据</span>
          {scene.summary.continuity_risks ? <em>⚠ {scene.summary.continuity_risks} 连续性提示</em> : null}
        </div>
      </summary>
      <div className="planning-scene-body">
        <div className="planning-facts-row">
          <span>景别：{countMap(scene.summary.shot_types)}</span>
          <span>用途：{countMap(scene.summary.coverage_roles)}</span>
          <span>最终决定：{countMap(scene.summary.editorial_decisions)}</span>
        </div>
        {scene.issues.length ? (
          <div className="planning-issue-list">
            {scene.issues.map((issue, index) => <p className={`planning-issue severity-${issue.severity}`} key={`${issue.code}-${index}`}>{issue.label || issue.code}</p>)}
          </div>
        ) : null}
        <div className="coverage-take-list">
          {scene.take_groups.map((take) => (
            <article className="coverage-take-row" key={take.group_id}>
              <div>
                <strong>{take.group_id}</strong>
                <span>{take.mapping_source === "human" ? "人工归集" : take.mapping_source === "automatic" ? "自动归集" : take.mapping_source}</span>
              </div>
              <div className="coverage-angle-chips">
                {take.angles.map((angle) => (
                  <span key={angle.clip_id} title={angle.supervisor_note || angle.name}>
                    {angle.camera || "—"} · {angle.shot_type !== "unknown" ? angle.shot_type : "景别未观察"}{angle.coverage_role !== "unknown" ? ` · ${angle.coverage_role}` : ""}
                  </span>
                ))}
              </div>
              <div className="coverage-take-state">
                {take.audit?.mapping_stale ? <em>归集变化 · 旧建议已隐藏</em> : null}
                {take.rough_cut?.continuity_risk && ["medium", "high"].includes(take.rough_cut.continuity_risk) ? <em>连续性 {take.rough_cut.continuity_risk}</em> : null}
                {take.editorial_decision?.state && take.editorial_decision.state !== "unreviewed" ? <strong>最终 {take.editorial_decision.state}</strong> : null}
              </div>
              {onOpenTake ? <button type="button" className="secondary" onClick={() => onOpenTake(take.group_id)}>查看 Take</button> : null}
            </article>
          ))}
        </div>
      </div>
    </details>
  );
}

export function CoverageWorkbench({ baseUrl, projectId, onOpenTake }: Props) {
  const client = useMemo(() => new PlanningClient(baseUrl), [baseUrl]);
  const [graph, setGraph] = useState<CoverageGraph | null>(null);
  const [episode, setEpisode] = useState<number | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("正在建立场景覆盖视图…");

  async function reload(nextEpisode = episode): Promise<void> {
    setState("loading");
    try {
      const payload = await client.coverage(projectId, { episode: nextEpisode });
      setGraph(payload);
      setState("ready");
      setMessage(`coverage.v1 · ${payload.summary.scenes} 场 · ${payload.summary.mapped_take_groups} Take`);
    } catch (error) {
      setState("error");
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => { void reload(episode); }, [client, projectId, episode]);

  const episodes = useMemo(() => [...new Set((graph?.scenes ?? []).map((scene) => scene.episode).filter((value) => value > 0))].sort((a, b) => a - b), [graph]);

  return (
    <section className="planning-workbench">
      <PlanningHeader eyebrow="剧本 / Coverage" title="覆盖" state={message} action={<button type="button" className="secondary" disabled={state === "loading"} onClick={() => void reload()}>刷新</button>} />
      {graph ? (
        <>
          <EpisodeToolbar episodes={episodes} value={episode} onChange={setEpisode} />
          <div className="planning-summary-strip">
            <span><strong>{graph.summary.scenes}</strong>场景</span>
            <span><strong>{graph.summary.mapped_take_groups}</strong>已归集 Take</span>
            <span><strong>{graph.summary.known_shots}</strong>景别有证据</span>
            <span className={graph.summary.continuity_risks ? "needs-attention" : ""}><strong>{graph.summary.continuity_risks}</strong>连续性提示</span>
            <span className={graph.summary.unplaced_groups ? "needs-attention" : ""}><strong>{graph.summary.unplaced_groups}</strong>未归集</span>
          </div>
          <p className="planning-contract-note">覆盖页只呈现已观察证据；“没有景别证据”不会被解释成“缺镜头”。场记景别优先于同 clip 的 AI 景别，但两者都不是最终剪辑决定。</p>
          <div className="planning-scene-list">
            {graph.scenes.map((scene) => <CoverageSceneRow scene={scene} onOpenTake={onOpenTake} key={scene.scene_id} />)}
          </div>
        </>
      ) : <div className={`planning-empty ${state === "error" ? "is-error" : ""}`}>{message}</div>}
    </section>
  );
}

function RoughCutSceneRow({ scene, onOpenTake }: { scene: RoughCutScene; onOpenTake?: (groupId: string) => void }) {
  return (
    <details className={`planning-scene readiness-${scene.readiness}`} open={scene.readiness !== "ready"}>
      <summary>
        <div className="planning-scene-title"><strong>{scene.scene_id}</strong><span>{scene.heading || `EP${scene.episode}`}</span></div>
        <div className="planning-scene-metrics"><span>{scene.summary.segments ?? scene.segments.length} 段</span><span>{scene.summary.explicit_best ?? 0} Best</span>{scene.summary.needs_choice ? <em>{scene.summary.needs_choice} 待选</em> : null}{scene.summary.conflicts ? <em>{scene.summary.conflicts} 冲突</em> : null}<strong>{readinessLabel(scene.readiness)}</strong></div>
      </summary>
      <div className="roughcut-segment-list">
        {scene.segments.map((segment) => <RoughCutSegmentRow segment={segment} onOpenTake={onOpenTake} key={segment.script.segment_id} />)}
      </div>
    </details>
  );
}

function RoughCutSegmentRow({ segment, onOpenTake }: { segment: RoughCutSegment; onOpenTake?: (groupId: string) => void }) {
  const primary = segment.primary_group_id ? segment.candidates.find((candidate) => candidate.group_id === segment.primary_group_id) ?? null : null;
  return (
    <article className={`roughcut-segment status-${segment.selection_status}`}>
      <div className="roughcut-script">
        <span>{segment.script.speaker || segment.script.type || "剧本"}</span>
        <p>{segment.script.text || "（无正文）"}</p>
      </div>
      <div className="roughcut-selection">
        <div className="roughcut-selection-head"><strong>{selectionLabel(segment.selection_status)}</strong>{primary ? <span>Primary · {primary.group_id}</span> : null}</div>
        {segment.issues.map((issue, index) => <p className={`planning-issue severity-${issue.severity || "info"}`} key={`${issue.code || "issue"}-${index}`}>{issue.label || issue.code}</p>)}
        <div className="roughcut-candidates">
          {segment.candidates.slice(0, 5).map((candidate) => (
            <div className={`roughcut-candidate ${candidate.group_id === segment.primary_group_id ? "is-primary" : ""} ${candidate.supervisor_blocked ? "is-blocked" : ""}`} key={candidate.group_id}>
              <div><strong>{candidate.group_id}</strong><span>{candidate.delivery_state} · {candidate.angles.map((angle) => `${angle.camera || "—"}/${angle.shot_type}`).join(" · ") || "无机位"}</span></div>
              <div className="roughcut-candidate-meta">{candidate.supervisor_blocked ? <em>场记 NG</em> : null}{candidate.supervisor_partial ? <em>部分可用</em> : null}{candidate.continuity_risk === "high" ? <em>高连续性风险</em> : null}</div>
              {onOpenTake ? <button type="button" className="secondary" onClick={() => onOpenTake(candidate.group_id)}>看片</button> : null}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export function RoughCutWorkbench({ baseUrl, projectId, onOpenTake }: Props) {
  const client = useMemo(() => new PlanningClient(baseUrl), [baseUrl]);
  const [plan, setPlan] = useState<RoughCutPlan | null>(null);
  const [episode, setEpisode] = useState<number | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("正在整理粗剪准备状态…");

  async function reload(nextEpisode = episode): Promise<void> {
    setState("loading");
    try {
      const payload = await client.roughCut(projectId, { episode: nextEpisode });
      setPlan(payload);
      setState("ready");
      setMessage(`rough_cut_plan.v1 · ${readinessLabel(payload.readiness)} · r${payload.revision}`);
    } catch (error) {
      setState("error");
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => { void reload(episode); }, [client, projectId, episode]);
  const episodes = useMemo(() => [...new Set((plan?.scenes ?? []).map((scene) => scene.episode).filter((value) => value > 0))].sort((a, b) => a - b), [plan]);
  const status = plan?.summary.selection_status ?? {};

  return (
    <section className="planning-workbench">
      <PlanningHeader eyebrow="剪辑 / Preparation" title="粗剪" state={message} action={<button type="button" className="secondary" disabled={state === "loading"} onClick={() => void reload()}>刷新</button>} />
      {plan ? (
        <>
          <EpisodeToolbar episodes={episodes} value={episode} onChange={setEpisode} />
          <div className="planning-summary-strip">
            <span><strong>{Number(plan.summary.segments ?? 0)}</strong>剧本段</span>
            <span><strong>{status.explicit_best ?? 0}</strong>已有 Best</span>
            <span className={status.needs_editorial_choice ? "needs-attention" : ""}><strong>{status.needs_editorial_choice ?? 0}</strong>待最终选择</span>
            <span className={(status.conflict_multiple_best || status.conflict_supervisor_vs_best) ? "needs-attention" : ""}><strong>{(status.conflict_multiple_best ?? 0) + (status.conflict_supervisor_vs_best ?? 0)}</strong>冲突</span>
            <span className={plan.summary.high_continuity_segments ? "needs-attention" : ""}><strong>{plan.summary.high_continuity_segments ?? 0}</strong>连续性关注</span>
          </div>
          <p className="planning-contract-note">粗剪规划只组织现有人工 authority：不会把自动归集或 Keep 偷升为 Best；场记 NG 与 Final Best 冲突时会阻塞，而不是替人决定谁覆盖谁。</p>
          <div className="planning-scene-list">{plan.scenes.map((scene) => <RoughCutSceneRow scene={scene} onOpenTake={onOpenTake} key={scene.scene_id} />)}</div>
        </>
      ) : <div className={`planning-empty ${state === "error" ? "is-error" : ""}`}>{message}</div>}
    </section>
  );
}

function AssemblySceneRow({ scene, onOpenTake }: { scene: AssemblyScene; onOpenTake?: (groupId: string) => void }) {
  return (
    <details className={`planning-scene readiness-${scene.readiness}`} open={scene.readiness !== "ready"}>
      <summary>
        <div className="planning-scene-title"><strong>{scene.scene_id}</strong><span>{scene.heading || `EP${scene.episode}`}</span></div>
        <div className="planning-scene-metrics"><span>{scene.summary.blocks} blocks</span><span>{formatDuration(scene.duration)}</span>{scene.summary.attention ? <em>{scene.summary.attention} 待处理</em> : null}{scene.summary.blocked ? <em>{scene.summary.blocked} 阻塞</em> : null}<strong>{readinessLabel(scene.readiness)}</strong></div>
      </summary>
      <div className="assembly-strip">
        {scene.blocks.map((block, index) => (
          <article className={`assembly-block kind-${block.kind} assembly-${block.assembly_status ?? "unknown"}`} key={`${block.group_id || "unresolved"}-${index}`}>
            {block.kind === "source" ? (
              <>
                <div><strong>{block.group_id}</strong><span>{block.angle.camera || "待选机位"}{block.angle.shot_type && block.angle.shot_type !== "unknown" ? ` · ${block.angle.shot_type}` : ""}</span></div>
                <small>{formatDuration(Number(block.duration ?? block.usable_range.duration ?? 0))} · {block.usable_range.status || "full_take"}</small>
                {block.continuity_risk === "high" ? <em>⚠ 高连续性风险</em> : null}
                {onOpenTake ? <button type="button" className="secondary" onClick={() => onOpenTake(block.group_id)}>看片</button> : null}
              </>
            ) : (
              <><strong>待选择</strong><span>{selectionLabel(block.selection_status)}</span><small>{block.script_segment_ids.length} 剧本段</small></>
            )}
          </article>
        ))}
      </div>
    </details>
  );
}

export function AssemblyWorkbench({ baseUrl, projectId, onOpenTake }: Props) {
  const client = useMemo(() => new PlanningClient(baseUrl), [baseUrl]);
  const [timeline, setTimeline] = useState<AssemblyTimeline | null>(null);
  const [episode, setEpisode] = useState<number | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("正在生成只读组接预览…");

  async function reload(nextEpisode = episode): Promise<void> {
    setState("loading");
    try {
      const payload = await client.assembly(projectId, { episode: nextEpisode });
      setTimeline(payload);
      setState("ready");
      setMessage(`assembly_timeline.v1 · ${readinessLabel(payload.readiness)} · ${formatDuration(payload.duration)}`);
    } catch (error) {
      setState("error");
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => { void reload(episode); }, [client, projectId, episode]);
  const episodes = useMemo(() => [...new Set((timeline?.scenes ?? []).map((scene) => scene.episode).filter((value) => value > 0))].sort((a, b) => a - b), [timeline]);

  return (
    <section className="planning-workbench">
      <PlanningHeader eyebrow="剪辑 / Preview" title="组接" state={message} action={<button type="button" className="secondary" disabled={state === "loading"} onClick={() => void reload()}>刷新</button>} />
      {timeline ? (
        <>
          <EpisodeToolbar episodes={episodes} value={episode} onChange={setEpisode} />
          <div className="planning-summary-strip">
            <span><strong>{timeline.summary.scenes}</strong>场景</span>
            <span><strong>{timeline.summary.blocks}</strong>组接块</span>
            <span><strong>{formatDuration(timeline.duration)}</strong>预计时长</span>
            <span className={(timeline.summary.statuses.selection_pending || timeline.summary.statuses.needs_review || timeline.summary.statuses.blocked) ? "needs-attention" : ""}><strong>{(timeline.summary.statuses.selection_pending ?? 0) + (timeline.summary.statuses.needs_review ?? 0) + (timeline.summary.statuses.blocked ?? 0)}</strong>待处理</span>
          </div>
          <p className="planning-contract-note">组接是只读预览：只有显式 Best 才能形成 source block；多机位没有人工 preferred clip 时保持待选，不自动替剪辑师选机位，也不会写 Selection Manifest 或 FCPXML。</p>
          <div className="planning-scene-list">{timeline.scenes.map((scene) => <AssemblySceneRow scene={scene} onOpenTake={onOpenTake} key={scene.scene_id} />)}</div>
        </>
      ) : <div className={`planning-empty ${state === "error" ? "is-error" : ""}`}>{message}</div>}
    </section>
  );
}
