import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  makeFooterStatusDeclaration,
  makeProjectionBridge as makeHostProjectionBridge,
  type ProjectionBridge,
} from "pi-cosmic-ui/boundary/host-status";
import { emptyProjection, footerStatus, type BackgroundTaskProjection } from "../task/model.ts";

const STATUS_KEY = "pi-background-task";

export type BackgroundTaskProjectionBridge = ProjectionBridge<BackgroundTaskProjection>;

export function makeProjectionBridge(
  events?: ExtensionAPI["events"],
): BackgroundTaskProjectionBridge {
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
