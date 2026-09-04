import { TimelineWorkbenchView } from "./TimelineWorkbenchView";
import { useTimelineWorkbenchModel } from "./useTimelineWorkbenchModel";
import { useTimelineAuthorityActions } from "./useTimelineAuthorityActions";
import { useTimelineSourceActions } from "./useTimelineSourceActions";
import "./editor-productization.css";

interface Props { baseUrl: string; projectId: string; }

export function TimelineWorkbench({ baseUrl, projectId }: Props) {
  const model = useTimelineWorkbenchModel(baseUrl, projectId);
  const timelineActions = useTimelineAuthorityActions(model);
  const sourceActions = useTimelineSourceActions(model, timelineActions.apply);
  return <TimelineWorkbenchView {...model} {...timelineActions} {...sourceActions} />;
}
