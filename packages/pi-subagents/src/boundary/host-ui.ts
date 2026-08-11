import { makeProjectionBridge, type ProjectionBridge } from "pi-cosmic-ui/boundary/host-status";
import type { SubagentProjection } from "../run/model.ts";
import { emptyProjection, fleetStatus } from "../run/projection.ts";

export { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-subagents";

export type SubagentProjectionBridge = ProjectionBridge<SubagentProjection>;

export function makeSubagentProjectionBridge(): SubagentProjectionBridge {
  return makeProjectionBridge({
    statusKey: STATUS_KEY,
    emptyProjection,
    footerStatus: fleetStatus,
  });
}
