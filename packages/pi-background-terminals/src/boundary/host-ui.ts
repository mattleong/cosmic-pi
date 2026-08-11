import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  makeFooterStatusDeclaration,
  makeProjectionBridge as makeHostProjectionBridge,
  type ProjectionBridge,
} from "pi-cosmic-ui/boundary/host-status";
import { emptyProjection, footerStatus } from "../job/projection.ts";
import type { BackgroundTerminalProjection } from "../job/model.ts";

export { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-background-terminals";

export type BackgroundTerminalProjectionBridge = ProjectionBridge<BackgroundTerminalProjection>;

export function makeProjectionBridge(
  events?: ExtensionAPI["events"],
): BackgroundTerminalProjectionBridge {
  return makeHostProjectionBridge({
    statusKey: STATUS_KEY,
    emptyProjection,
    footerStatus,
    footerPlacement: makeFooterStatusDeclaration({
      events,
      owner: STATUS_KEY,
      statusKey: STATUS_KEY,
      placement: { region: "details", order: 1010 },
    }),
  });
}
