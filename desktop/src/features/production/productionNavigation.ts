export type ProductionWorkspace = "material" | "script" | "timeline" | "review";

export interface ProductionNavigationIntent {
  projectId: string;
  workspace: ProductionWorkspace;
  nonce: number;
  groupId?: string;
  clipId?: string;
  scriptSegmentId?: string;
  timelineClipId?: string;
}
