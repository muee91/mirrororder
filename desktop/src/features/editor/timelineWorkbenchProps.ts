import type { ProductionNavigationIntent } from "../production/productionNavigation";
import type { TimelineAuthorityActions } from "./useTimelineAuthorityActions";
import type { TimelineWorkbenchModel } from "./useTimelineWorkbenchModel";
import type { TimelineSourceActions } from "./useTimelineSourceActions";
import type { MulticamSyncTimeline } from "../../api/syncTimeline";

export type TimelineWorkbenchProps = TimelineWorkbenchModel &
  TimelineAuthorityActions &
  TimelineSourceActions & {
    focusIntent: ProductionNavigationIntent | null;
    focusLabel: string;
    onOpenDelivery: () => void;
    onOpenRepair?: (clipId: string) => void;
    baseUrl: string;
    syncTimeline?: MulticamSyncTimeline;
    onMulticamSync?: () => void;
  };
