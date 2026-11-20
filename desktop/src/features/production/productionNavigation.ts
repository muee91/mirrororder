import type { ProductionPage } from "../../app/resumeState";

export type ProductionWorkspace = "material" | "script" | "timeline" | "review";

export interface ProductionSelectionContext {
  projectId: string;
  groupId?: string;
  clipId?: string;
  mediaId?: string;
  recordId?: string;
  sourceRange?: { start: number; end?: number; basis: "source" | "take" };
  returnPage?: ProductionPage;
  scriptSegmentId?: string;
  timelineClipId?: string;
}

export interface ProductionNavigationIntent extends ProductionSelectionContext {
  workspace: ProductionWorkspace;
  nonce: number;
}
