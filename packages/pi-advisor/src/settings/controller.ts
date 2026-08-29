import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { completeSettingsArguments } from "pi-cosmic-core";
import type { PiCommandError } from "../boundary/host-commands.ts";
import {
  openAdvisorDashboard,
  openAdvisorSetup,
  showAdvisorUsage,
  updateConfig,
} from "./panels.ts";
import { notifyCardAction } from "./notify.ts";
import type { AdvisorCommandActions, AdvisorCommandState } from "./types.ts";

export type { AdvisorCommandActions } from "./types.ts";

export const ADVISOR_COMMAND_DESCRIPTION = "Advisor controls, review, and usage";
const SUBCOMMANDS = ["on", "off", "review", "fix", "dismiss", "cancel", "setup", "usage"] as const;
const SUBCOMMAND_DESCRIPTIONS = {
  on: "Enable the advisor",
  off: "Disable the advisor",
  review: "Review the last completed response",
  fix: "Send guidance for the open advisor card",
  dismiss: "Dismiss the open advisor card",
  cancel: "Cancel pending advisor work",
  setup: "Choose the advisor model",
  usage: "Show advisor usage and outcomes",
} satisfies Readonly<Record<(typeof SUBCOMMANDS)[number], string>>;

export const completeAdvisorCommandArguments = (prefix: string) =>
  completeSettingsArguments(
    prefix,
    [],
    SUBCOMMANDS.map((value) => ({
      value,
      label: value,
      description: SUBCOMMAND_DESCRIPTIONS[value],
    })),
  );

export function handleAdvisorCommand(
  args: string,
  ctx: ExtensionCommandContext,
  state: AdvisorCommandState,
  actions: AdvisorCommandActions,
): Effect.Effect<void, PiCommandError> {
  return Effect.suspend(() => {
    const command = args.trim().toLowerCase();
    if (!command) return openAdvisorDashboard(ctx, state, actions);
    if (command === "review") {
      const unavailable = manualReviewUnavailableReason(ctx, state);
      if (unavailable) return Effect.sync(() => ctx.ui.notify(unavailable, "warning"));
      return actions.reviewLast(ctx).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            ctx.ui.notify(reviewRequestMessage(result), result === "started" ? "info" : "warning"),
          ),
        ),
        Effect.asVoid,
      );
    }
    if (command === "fix")
      return Effect.sync(() => notifyCardAction(ctx, actions.fixLast(ctx), "fixed"));
    if (command === "dismiss")
      return Effect.sync(() => notifyCardAction(ctx, actions.dismissLast(ctx), "dismissed"));
    if (command === "cancel")
      return actions.cancel(ctx).pipe(
        Effect.tap((cancelled) =>
          Effect.sync(() =>
            ctx.ui.notify(
              cancelled ? "Cancelled pending Advisor work." : "No Advisor review is active.",
              "info",
            ),
          ),
        ),
        Effect.asVoid,
      );
    if (command === "on") {
      if (!advisorModelReady(ctx, state.snapshot.config)) return openAdvisorSetup(ctx, state);
      return updateConfig(ctx, state, { enabled: true }).pipe(
        Effect.tap((updated) =>
          updated ? Effect.sync(() => ctx.ui.notify("Advisor is on.", "info")) : Effect.void,
        ),
        Effect.asVoid,
      );
    }
    if (command === "off")
      return updateConfig(ctx, state, { enabled: false }).pipe(
        Effect.tap((updated) =>
          updated ? Effect.sync(() => ctx.ui.notify("Advisor is off.", "info")) : Effect.void,
        ),
        Effect.asVoid,
      );
    if (command === "setup") return openAdvisorSetup(ctx, state);
    if (command === "usage")
      return Effect.sync(() => showAdvisorUsage(ctx, state.snapshot.metrics));
    return Effect.sync(() => ctx.ui.notify(`Usage: /advisor [${SUBCOMMANDS.join("|")}]`, "error"));
  });
}

function manualReviewUnavailableReason(
  ctx: ExtensionCommandContext,
  state: AdvisorCommandState,
): string | undefined {
  if (!advisorModelReady(ctx, state.snapshot.config))
    return "Advisor needs an available authenticated model. Run /advisor setup.";
  return undefined;
}

function advisorModelReady(
  ctx: ExtensionCommandContext,
  config: AdvisorCommandState["snapshot"]["config"],
): boolean {
  if (!config.provider || !config.model) return false;
  const model = ctx.modelRegistry.find(config.provider, config.model);
  return Boolean(model && ctx.modelRegistry.hasConfiguredAuth(model));
}

function reviewRequestMessage(result: "started" | "unavailable" | "cancelled"): string {
  if (result === "started") return "Advisor review started.";
  if (result === "unavailable") return "No completed response is available to review.";
  return "Advisor review could not start. Try again.";
}
