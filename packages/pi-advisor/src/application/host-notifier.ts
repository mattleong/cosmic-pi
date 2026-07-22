import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export type AdvisorNotificationLevel = "info" | "warning" | "error";
export interface HostNotifierShape {
  /** Mandatory synchronous Pi UI boundary; hostile callbacks are isolated here. */
  readonly notify: (
    ctx: Pick<ExtensionContext, "ui">,
    message: string,
    level: AdvisorNotificationLevel,
  ) => void;
}

export class HostNotifier extends Context.Service<HostNotifier, HostNotifierShape>()(
  "pi-advisor/application/host-notifier/HostNotifier",
) {}

export const hostNotifierLayer = Layer.succeed(
  HostNotifier,
  HostNotifier.of({
    notify: (ctx, message, level) => {
      try {
        ctx.ui.notify(message, level);
      } catch {
        // The Pi host cannot escape or own application lifecycle cleanup.
      }
    },
  }),
);
