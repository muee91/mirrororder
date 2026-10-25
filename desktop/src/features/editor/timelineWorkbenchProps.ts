import type { ProductionNavigationIntent } from "../production/productionNavigation";
import type { TimelineAuthorityActions } from "./useTimelineAuthorityActions";
import type { TimelineWorkbenchModel } from "./useTimelineWorkbenchModel";
import type { TimelineSourceActions } from "./useTimelineSourceActions";

export type TimelineWorkbenchProps = TimelineWorkbenchModel &
  TimelineAuthorityActions &
  TimelineSourceActions & {
    focusIntent: ProductionNavigationIntent | null;
    focusLabel: string;
    onOpenDelivery: () => void;
  };
