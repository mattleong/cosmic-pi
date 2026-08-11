import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  makeFooterStatusDeclaration,
  makeProjectionBridge,
  type ProjectionBridge,
} from "pi-cosmic-ui/boundary/host-status";
import type { SubagentProjection } from "../run/model.ts";
import { emptyProjection, fleetStatus } from "../run/projection.ts";

export { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-subagents";

export type SubagentProjectionBridge = ProjectionBridge<SubagentProjection>;

export function makeSubagentProjectionBridge(
  events?: ExtensionAPI["events"],
): SubagentProjectionBridge {
  return makeProjectionBridge({
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
}
