// Shared Advisor card action notifications are confined here.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AdvisorCommandActions } from "./types.ts";

export function notifyCardAction(
  ctx: ExtensionCommandContext,
  result: ReturnType<AdvisorCommandActions["fixLast"]>,
  completed: "fixed" | "dismissed",
): void {
  const [message, level] =
    result === "applied"
      ? [`Advisor card ${completed}.`, "info" as const]
      : result === "unavailable"
        ? ["No open Advisor card.", "warning" as const]
        : result === "delivery-failed"
          ? ["Advisor could not send guidance; the card remains open.", "error" as const]
          : [
              completed === "fixed"
                ? "Guidance was sent, but Advisor could not mark the card fixed."
                : "Advisor could not mark the card dismissed.",
              "error" as const,
            ];
  ctx.ui.notify(message, level);
}
