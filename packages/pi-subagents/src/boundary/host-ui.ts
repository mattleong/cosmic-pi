import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  makeFooterStatusDeclaration,
  makeProjectionBridge,
  startHostUiTicker,
  type ProjectionBridge,
} from "pi-cosmic-ui/boundary/host-status";
import type { SubagentProjection } from "../run/model.ts";
import { emptyProjection, fleetStatus } from "../run/projection.ts";
import {
  makeSubagentActivityPresentation,
  makeSubagentActivityWidgetHost,
  shouldSuppressSubagentFooter,
  type SubagentToolPresentation,
} from "./host-activity-widget.ts";

const STATUS_KEY = "pi-subagents";

export interface SubagentProjectionBridge extends ProjectionBridge<SubagentProjection> {
  readonly bindToolPresentation: () => SubagentToolPresentation;
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
      base.setContext(ctx);
      widget.setContext(ctx);
      syncFooter();
    },
    setFooterEnabled: base.setFooterEnabled,
    clear: () => {
      widget.clear();
      presentation.clear();
      base.clear();
    },
    bindToolPresentation: presentation.bindToolPresentation,
  };
}
