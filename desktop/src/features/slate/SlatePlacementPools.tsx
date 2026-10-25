import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { HostConnection, HostConnectionError, type ReviewModelPayload, type ReviewTakeGroup, errorMessage } from "../../api/host";
import { MediaRoleClient, type MediaInventoryItem } from "../../api/mediaRoles";
import { TakeListRow } from "../material-script/TakeCard";
import {
  buildSlatePools,
  buildSlateSceneTargets,
  createSlateTakeDragPayload,
  decodeSlateTakeDragPayload,
  hasHumanPlacement,
  isReviewExcluded,
  SLATE_TAKE_MIME,
  type SlateSceneTarget,
  type SlateTakeDragPayload,
} from "./slatePools";
import "./slate-placement-pools.css";

interface Props {
  baseUrl: string;
  projectId: string;
  review: ReviewModelPayload | null;
  actor?: string;
  onChanged: () => Promise<void>;
  onSelectTake?: (groupId: string) => void;
}

function needsRefresh(error: unknown): boolean {
  return error instanceof HostConnectionError && (error.status === 409 || error.message.includes("请刷新"));
}

function currentActor(fallback = ""): string {
  try {
    return globalThis.localStorage?.getItem("mirrororder.productionActor")?.trim() || fallback.trim();
  } catch {
    return fallback.trim();
  }
}

function placementLabel(take: ReviewTakeGroup, targets: SlateSceneTarget[]): string {
  const placement = take.editorial_state.legacy_manual?.placement;
  if (!placement) return "已归集";
  const segmentIds = placement.script_segment_ids?.filter(Boolean) ?? [];
  const episode = placement.episode_ids?.[0];
  const target = segmentIds.length && episode
    ? targets.find((item) => item.episode === episode && item.segmentIds.length === segmentIds.length && item.segmentIds.every((id, index) => id === segmentIds[index]))
    : undefined;
  if (target) return `EP${target.episode} · ${target.sceneId}`;
  if (episode && segmentIds.length) return `EP${episode} · ${segmentIds.length} 段`;
  if (episode) return `EP${episode} · 粗归集`;
  return segmentIds.length ? `${segmentIds.length} 段` : "已归集";
}

function Pool({ title, count, children, drop, onDrop }: { title: string; count: number; children: ReactNode; drop?: boolean; onDrop?: (event: DragEvent<HTMLDivElement>) => void }) {
  return (
    <section className={`golden-placement-pool ${drop ? "is-drop-target" : ""}`} onDragOver={drop ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } : undefined} onDrop={drop ? onDrop : undefined}>
      <header><strong>{title}</strong><span>{count}</span></header>
      <div>{children}</div>
    </section>
  );
}

export function SlatePlacementPools({ baseUrl, projectId, review, actor = "", onChanged, onSelectTake }: Props) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const media = useMemo(() => new MediaRoleClient(baseUrl), [baseUrl]);
  const [inventory, setInventory] = useState<MediaInventoryItem[]>([]);
  const [message, setMessage] = useState("Review placement 辅助区");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void media.inventory(projectId).then((payload) => { if (!cancelled) setInventory(payload.items); }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [media, projectId, review?.revisions.review]);

  const takes = review?.take_groups ?? [];
  const pools = useMemo(() => buildSlatePools(takes, inventory), [inventory, takes]);
  const targets = useMemo(() => buildSlateSceneTargets(review), [review]);

  function beginDrag(event: DragEvent<HTMLElement>, take: ReviewTakeGroup): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(SLATE_TAKE_MIME, JSON.stringify(createSlateTakeDragPayload(take)));
    event.dataTransfer.setData("text/plain", take.group_id);
  }

  function payload(event: DragEvent<HTMLElement>): SlateTakeDragPayload | null {
    return decodeSlateTakeDragPayload(event.dataTransfer.getData(SLATE_TAKE_MIME));
  }

  async function write(action: (actorValue: string) => Promise<unknown>, success: string): Promise<void> {
    const actorValue = currentActor(actor);
    if (!actorValue) { setMessage("Review 归集操作前需要操作者昵称。"); return; }
    setBusy(true);
    try {
      await action(actorValue);
      // 写入已成功；随后的父级刷新失败不能改写成功结果，只报告刷新失败。
      setMessage(success);
      try {
        await onChanged();
      } catch {
        setMessage(`${success}；界面刷新失败，请手动刷新核对。`);
      }
    } catch (error) {
      if (needsRefresh(error)) {
        await onChanged().catch(() => undefined);
        setMessage("Review 已被其他操作更新，已刷新；请重新操作。");
      } else setMessage(errorMessage(error));
    } finally { setBusy(false); }
  }

  function place(event: DragEvent<HTMLButtonElement>, target: SlateSceneTarget): void {
    event.preventDefault();
    const drag = payload(event);
    if (!drag || !review || !target.segmentIds.length) return;
    const take = takes.find((item) => item.group_id === drag.groupId);
    if (!take || isReviewExcluded(take)) { setMessage("该 Take 已排除或不在当前 Review；恢复后再归集。"); return; }
    void write(
      (actorValue) => host.setGroupPlacement(projectId, {
        groupId: drag.groupId,
        actor: actorValue,
        expectedRevision: review.revisions.review,
        episodeIds: [target.episode],
        scriptSegmentIds: target.segmentIds,
        interaction: "drag",
        sourceSurface: "golden-slate-placement-pools",
        sourceKind: drag.sourceKind,
        sourceClipId: drag.sourceClipId,
      }),
      `已归集 ${drag.groupId} → EP${target.episode} · ${target.sceneId}`,
    );
  }

  function restoreOrClear(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const drag = payload(event);
    if (!drag || !review) return;
    const take = takes.find((item) => item.group_id === drag.groupId);
    if (!take) return;
    if (isReviewExcluded(take)) {
      void write(
        (actorValue) => host.setGroupExclusion(projectId, { groupId: drag.groupId, actor: actorValue, excluded: false, expectedRevision: review.revisions.review, sourceSurface: "golden-slate-placement-pools", sourceClipId: drag.sourceClipId }),
        `已恢复 ${drag.groupId} 到待归集`,
      );
    } else if (hasHumanPlacement(take)) {
      void write(
        (actorValue) => host.clearGroupPlacement(projectId, { groupId: drag.groupId, actor: actorValue, expectedRevision: review.revisions.review, interaction: "drag", sourceSurface: "golden-slate-placement-pools", sourceKind: drag.sourceKind, sourceClipId: drag.sourceClipId }),
        `已清除 ${drag.groupId} 的人工归集；场记事实保留`,
      );
    } else setMessage("只有已归集或已排除 Take 可以拖回待归集。");
  }

  function setExcluded(take: ReviewTakeGroup, excluded: boolean): void {
    if (!review) return;
    void write(
      (actorValue) => host.setGroupExclusion(projectId, { groupId: take.group_id, actor: actorValue, excluded, expectedRevision: review.revisions.review, sourceSurface: "golden-slate-placement-pools", sourceClipId: take.angles[0]?.clip_id }),
      excluded ? `已排除 ${take.group_id}；这是 Review 状态，不等于场记 NG` : `已恢复 ${take.group_id}`,
    );
  }

  return (
    <section className="golden-placement-workbench" aria-label="Review 归集辅助">
      <header className="golden-placement-heading"><div><strong>Review 归集辅助</strong><span>只改变 Review placement / exclusion，不覆盖场记生产事实。</span></div><small>{busy ? "写入中…" : message}</small></header>
      <div className="golden-placement-layout">
        <div className="golden-placement-pools">
          <Pool title="待归集" count={pools.pending.length} drop onDrop={restoreOrClear}>
            {pools.pending.map((take) => <TakeListRow key={take.group_id} take={take} onSelect={() => onSelectTake?.(take.group_id)} onDragStart={beginDrag} action={() => setExcluded(take, true)} actionLabel="排除" />)}
            {!pools.pending.length ? <span className="golden-placement-empty">没有待归集 Take</span> : null}
          </Pool>
          <Pool title="已归集" count={pools.placed.length}>
            {pools.placed.map((take) => <TakeListRow key={take.group_id} take={take} detail={placementLabel(take, targets)} onSelect={() => onSelectTake?.(take.group_id)} onDragStart={beginDrag} />)}
            {!pools.placed.length ? <span className="golden-placement-empty">没有人工归集 Take</span> : null}
          </Pool>
          <Pool title="已排除" count={pools.excluded.length}>
            {pools.excluded.map((take) => <TakeListRow key={take.group_id} take={take} onSelect={() => onSelectTake?.(take.group_id)} onDragStart={beginDrag} action={() => setExcluded(take, false)} actionLabel="恢复" />)}
            {!pools.excluded.length ? <span className="golden-placement-empty">没有 Review 排除项</span> : null}
          </Pool>
          <Pool title="孤立素材" count={pools.orphan.length}>
            {pools.orphan.map((item) => <div className="golden-placement-orphan" key={item.media_id}><strong>{item.display_name || item.media_id}</strong><span>{item.folder_label || "未分组"} · {item.inferred_camera || "未知机位"}</span></div>)}
            {!pools.orphan.length ? <span className="golden-placement-empty">没有未关联媒体</span> : null}
          </Pool>
        </div>
        <div className="golden-placement-targets">
          <header><strong>场景目标</strong><span>拖 Take 到场景 = 人工归集到该场全部可归集剧本段</span></header>
          <div>
            {targets.map((target) => <button type="button" key={target.key} disabled={busy || !target.segmentIds.length} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => place(event, target)}><strong>EP{target.episode} · {target.sceneId}</strong><span>{target.heading}</span><small>{target.segmentIds.length ? `${target.segmentIds.length} 个剧本段` : "无可归集剧本段"}</small></button>)}
            {!targets.length ? <span className="golden-placement-empty">当前项目没有场景目标</span> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
