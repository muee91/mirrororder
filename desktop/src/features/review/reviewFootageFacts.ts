import type { ReviewAngle, ReviewTakeGroup } from "../../api/host";
import type { SlateAttachment, SlateBoard, SlateEntry, SlateRecord, SlateStatus } from "../../api/production";

export type SlateReadState = "loading" | "ready" | "error";
export type FinalState = "unreviewed" | "best" | "keep" | "reject";
export const finalLabels: Record<FinalState, string> = { unreviewed: "未决定", best: "首选", keep: "保留", reject: "废弃" };
export const slateLabels: Record<SlateStatus, string> = { unmarked: "待定", usable: "可用", partial: "部分可用", ng: "NG" };

export function finalDecision(take: ReviewTakeGroup) {
  type Decision = { state?: string; actor?: string };
  const projection = take.editorial_state?.editorial_decision as (Decision & { group?: Decision | null }) | undefined;
  const decision = projection?.group ?? projection;
  const state = decision?.state;
  const value: FinalState = state === "best" || state === "keep" || state === "reject" ? state : "unreviewed";
  return { state: value, actor: decision?.actor?.trim() || "" };
}

export interface AngleSlateFact {
  status?: SlateStatus;
  preferred: boolean;
  note: string;
  record: SlateRecord;
}

export interface ReviewSlateFacts {
  take?: SlateRecord;
  angles: ReadonlyMap<string, AngleSlateFact>;
}

function legacyRecord(entry: SlateEntry): SlateRecord {
  const attachments = Object.entries(entry.angles ?? {}).map(([clip_id, angle]) => ({
    clip_id, media_id: "", camera: "", display_name: "", shot_type: angle.shot_type, source_role: "", note: angle.note ?? "",
  }));
  return { ...entry, record_id: "", source_group_id: entry.group_id, attachments };
}

type AttachmentLink = { record: SlateRecord; attachment: SlateAttachment };

export function indexReviewSlates(takes: readonly ReviewTakeGroup[], board: SlateBoard | null) {
  const facts = new Map<string, ReviewSlateFacts>();
  const coordinates = new Map<string, SlateRecord>();
  const byGroup = new Map<string, SlateRecord>();
  const byClip = new Map<string, AttachmentLink[]>();
  const byMedia = new Map<string, AttachmentLink[]>();
  const records = Object.values(board?.records ?? {}).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  for (const record of records) {
    if (record.source_group_id) {
      if (byGroup.has(record.source_group_id)) continue;
      byGroup.set(record.source_group_id, record);
    }
    for (const attachment of record.attachments ?? []) {
      const index = attachment.clip_id ? byClip : byMedia;
      const key = attachment.clip_id || attachment.media_id;
      if (!key) continue;
      const links = index.get(key) ?? [];
      links.push({ record, attachment });
      index.set(key, links);
    }
  }
  for (const group of takes) {
    const id = group.group_id;
    const snapshot = (group as ReviewTakeGroup & { script_supervisor?: SlateEntry }).script_supervisor;
    const entry = board ? board.entries?.[id] : snapshot;
    const take = byGroup.get(id) ?? (entry?.group_id === id ? legacyRecord(entry) : undefined);
    if (take) coordinates.set(id, take);
    const angles = new Map<string, AngleSlateFact>();
    for (const angle of group.angles) {
      const clipLinks = (byClip.get(angle.clip_id) ?? []).filter(item => matchesAngle(item.attachment, angle));
      const mediaLinks = byMedia.get(angle.media_id) ?? [];
      const link = clipLinks.find(item => item.record !== take) ?? clipLinks[0]
        ?? mediaLinks.find(item => item.record !== take) ?? mediaLinks[0];
      const ownAttachment = take?.attachments.find(item => matchesAngle(item, angle));
      const record = link?.record ?? take;
      if (!record) continue;
      const attachment = link?.attachment ?? ownAttachment;
      // A stand-alone slate attached to one camera describes only that camera.
      const separate = record !== take;
      const status = separate ? record.status : undefined;
      const preferred = [take, record].some(source => {
        const key = source?.preferred_clip_id;
        return key && (key === angle.clip_id || (attachment && !attachment.clip_id && key === angle.media_id));
      });
      const notes = [ownAttachment?.note, attachment?.note, separate ? record.note : undefined].filter((s): s is string => Boolean(s?.trim()));
      if (status || preferred || notes.length) angles.set(angle.clip_id, { status, preferred, note: [...new Set(notes)].join(" · "), record });
      if (link && !coordinates.has(id)) coordinates.set(id, record);
    }
    if (take || angles.size) facts.set(id, { take, angles });
  }
  return { facts, coordinates };
}

function matchesAngle(attachment: SlateAttachment, angle: ReviewAngle): boolean {
  return attachment.clip_id
    ? attachment.clip_id === angle.clip_id && (!attachment.media_id || attachment.media_id === angle.media_id)
    : Boolean(attachment.media_id && attachment.media_id === angle.media_id);
}

export function matchesSlateStatus(facts: ReviewSlateFacts | undefined, status: SlateStatus): boolean {
  return facts?.take?.status === status || [...(facts?.angles.values() ?? [])].some(angle => angle.status === status);
}
