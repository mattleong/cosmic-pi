import {
  makeProjectionBridge as makeHostProjectionBridge,
  type ProjectionBridge,
} from "pi-cosmic-ui/boundary/host-status";
import { emptyProjection, footerStatus } from "../job/projection.ts";
import type { BackgroundTerminalProjection } from "../job/model.ts";

export { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";

const STATUS_KEY = "pi-background-terminals";

export type BackgroundTerminalProjectionBridge = ProjectionBridge<BackgroundTerminalProjection>;

export function makeProjectionBridge(): BackgroundTerminalProjectionBridge {
  return makeHostProjectionBridge({ statusKey: STATUS_KEY, emptyProjection, footerStatus });
}
