export type ProductionWorkspace = "material" | "script" | "timeline" | "review";

export interface ProductionSelectionContext {
  projectId: string;
  groupId?: string;
  clipId?: string;
  scriptSegmentId?: string;
  timelineClipId?: string;
}

export interface ProductionNavigationIntent extends ProductionSelectionContext {
  workspace: ProductionWorkspace;
  nonce: number;
}
