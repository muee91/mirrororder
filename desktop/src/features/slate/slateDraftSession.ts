import type { SlateRecord } from "../../api/production";

export type SlateDraft = SlateRecord & {
  dirty: boolean;
  derived: boolean;
  derivedSource: string;
  xmlOrder: number;
};

export type PendingSlateDrafts = ReadonlyMap<string, {
  row: SlateDraft;
  baseline: string | null;
}>;

export interface SlateDraftSession {
  workspaceId: string;
  signal: AbortSignal;
  read(): PendingSlateDrafts | undefined;
  write(drafts: PendingSlateDrafts): void;
}
