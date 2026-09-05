import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  makeFooterStatusDeclaration,
  makeProjectionBridge,
  startHostUiTicker,
  type ProjectionBridge,
} from "pi-cosmic-ui/boundary/host-status";
import type { SubagentProjection } from "../run/model.ts";
import { emptyProjection, fleetStatus } from "../run/projection.ts";
import type { SubagentActivityPresentationSnapshot } from "../ui/activity-panel.ts";
import {
  makeSubagentActivityPresentation,
  makeSubagentActivityWidgetHost,
  shouldSuppressSubagentFooter,
  type SubagentToolPresentation,
} from "./host-activity-widget.ts";

const STATUS_KEY = "pi-subagents";

export interface SubagentProjectionBridge extends ProjectionBridge<SubagentProjection> {
  readonly bindToolPresentation: () => SubagentToolPresentation;
  readonly setActivityAvailable: (available: boolean) => void;
  readonly getActivityPresentation: () => SubagentActivityPresentationSnapshot;
  readonly subscribeActivityPresentation: (listener: () => void) => () => void;
}

export interface SubagentProjectionBridgeOptions {
  readonly startTicker?: typeof startHostUiTicker | undefined;
  readonly getNow?: (() => number) | undefined;
}

export function makeSubagentProjectionBridge(
  events?: ExtensionAPI["events"],
  options: SubagentProjectionBridgeOptions = {},
): SubagentProjectionBridge {
  const base = makeProjectionBridge({
    statusKey: STATUS_KEY,
    emptyProjection,
    footerStatus: fleetStatus,
    footerPlacement: makeFooterStatusDeclaration({
      events,
      owner: STATUS_KEY,
      statusKey: STATUS_KEY,
      placement: { region: "details", order: 1000 },
    }),
  });
  let context: ExtensionContext | undefined;
  let activityAvailable = false;
  const presentation = makeSubagentActivityPresentation();
  const syncFooter = () =>
    base.setFooterEnabled(!shouldSuppressSubagentFooter(base.get(), presentation));
  presentation.subscribe(syncFooter);
  const widget = makeSubagentActivityWidgetHost({
    getProjection: base.get,
    subscribeProjection: base.subscribe,
    presentation,
    startTicker: options.startTicker ?? startHostUiTicker,
    getNow: options.getNow,
  });

  return {
    get: base.get,
    subscribe: base.subscribe,
    publish: (projection) => {
      base.publish(projection);
      syncFooter();
    },
    setContext: (ctx) => {
      context = ctx;
      base.setContext(ctx);
      if (activityAvailable) presentation.setPanelAvailable(true);
      else widget.setContext(ctx);
      syncFooter();
    },
    setActivityAvailable: (available) => {
      if (available === activityAvailable) return;
      activityAvailable = available;
      if (available) {
        widget.clear();
        presentation.setPanelAvailable(true);
      } else {
        presentation.setPanelAvailable(false);
        widget.setContext(context);
      }
      syncFooter();
    },
    setFooterEnabled: base.setFooterEnabled,
    clear: () => {
      context = undefined;
      activityAvailable = false;
      widget.clear();
      presentation.clear();
      base.clear();
    },
    bindToolPresentation: presentation.bindToolPresentation,
    getActivityPresentation: presentation.get,
    subscribeActivityPresentation: presentation.subscribe,
  };
}
