import { useEffect, useMemo, useRef, useState } from "react";
import type { ProductionNavigationIntent } from "../production/productionNavigation";
import { takeDisplayLabel } from "../material-script/TakeCard";
import { DeliveryWorkbench } from "../delivery/DeliveryWorkbench";
import { TimelineWorkbenchView } from "./TimelineWorkbenchView";
import { useTimelineWorkbenchModel } from "./useTimelineWorkbenchModel";
import { useTimelineAuthorityActions } from "./useTimelineAuthorityActions";
import { useTimelineSourceActions } from "./useTimelineSourceActions";
import "./editor-productization.css";

interface Props {
  baseUrl: string;
  projectId: string;
  focusIntent?: ProductionNavigationIntent | null;
  deliveryRequestNonce?: number;
}

export function TimelineWorkbench({
  baseUrl,
  projectId,
  focusIntent = null,
  deliveryRequestNonce = 0,
}: Props) {
  const model = useTimelineWorkbenchModel(baseUrl, projectId);
  const timelineActions = useTimelineAuthorityActions(model);
  const sourceActions = useTimelineSourceActions(model, timelineActions.apply);
  const appliedFocusNonce = useRef(0);
  const [deliveryOpen, setDeliveryOpen] = useState(false);

  const focusedTake = useMemo(() => {
    if (!focusIntent?.groupId || !model.review) return null;
    return model.review.take_groups.find((take) => take.group_id === focusIntent.groupId) ?? null;
  }, [focusIntent?.groupId, model.review]);
  const focusLabel = focusedTake ? takeDisplayLabel(focusedTake) : focusIntent?.groupId ? "当前 Take" : "";

  useEffect(() => {
    if (deliveryRequestNonce > 0) setDeliveryOpen(true);
  }, [deliveryRequestNonce]);

  useEffect(() => {
    if (!focusIntent || focusIntent.workspace !== "timeline" || focusIntent.projectId !== projectId) return;
    if (appliedFocusNonce.current === focusIntent.nonce) return;
    if (!model.review || !model.snapshot || !model.sequence) return;

    const sourceById = new Map(model.snapshot.project.sources.map((source) => [source.source_id, source]));
    const timelineClips = model.sequence.tracks.flatMap((track) => track.clips);
    const timelineClip = timelineClips.find((clip) => {
      if (focusIntent.timelineClipId && clip.clip_id === focusIntent.timelineClipId) return true;
      if (focusIntent.groupId && clip.metadata.group_id === focusIntent.groupId) return true;
      if (focusIntent.clipId) return sourceById.get(clip.selected_angle_source_id ?? clip.source_id)?.clip_id === focusIntent.clipId;
      return false;
    }) ?? null;

    const sourceOption = model.sourceOptions.find((option) => focusIntent.clipId && option.source.clip_id === focusIntent.clipId)
      ?? model.sourceOptions.find((option) => focusIntent.groupId && option.groupId === focusIntent.groupId)
      ?? null;

    if (timelineClip) sourceActions.selectTimelineClip(timelineClip);
    if (sourceOption) sourceActions.chooseSource(sourceOption);

    appliedFocusNonce.current = focusIntent.nonce;
    if (timelineClip && sourceOption) {
      model.setMessage(`已定位 ${focusLabel || "当前 Take"} · 时间线片段与 Source 已就绪`);
    } else if (timelineClip) {
      model.setMessage(`已定位 ${focusLabel || "当前 Take"} 的时间线片段；当前 Source 不可播放或绑定已变化。`);
    } else if (sourceOption) {
      model.setMessage(`已定位 ${focusLabel || "当前 Take"} 的 Source；可在当前播放头插入或覆盖。`);
    } else {
      model.setMessage(`${focusLabel || "当前 Take"} 暂无可用 Timeline Source；先检查本机素材绑定或建立初始顺片。`);
    }
  }, [focusIntent, focusLabel, model.review, model.sequence, model.snapshot, model.sourceOptions, projectId, sourceActions]);

  return (
    <div className="timeline-workspace-shell">
      <TimelineWorkbenchView
        {...model}
        {...timelineActions}
        {...sourceActions}
        focusIntent={focusIntent}
        focusLabel={focusLabel}
        onOpenDelivery={() => setDeliveryOpen(true)}
      />
      {deliveryOpen ? (
        <div className="workspace-context-layer timeline-delivery-layer">
          <button type="button" className="workspace-context-backdrop" aria-label="关闭交付" onClick={() => setDeliveryOpen(false)} />
          <aside className="workspace-context-drawer timeline-delivery-panel" aria-label="时间线交付">
            <header className="workspace-context-heading">
              <div><span>时间线后续流程</span><strong>交付 / 导出</strong></div>
              <button type="button" className="secondary" onClick={() => setDeliveryOpen(false)}>关闭</button>
            </header>
            <DeliveryWorkbench baseUrl={baseUrl} projectId={projectId} />
          </aside>
        </div>
      ) : null}
    </div>
  );
}
