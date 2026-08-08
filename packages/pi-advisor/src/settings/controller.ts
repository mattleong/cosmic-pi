// Promise-shaped Pi command handlers are an explicit host boundary.
// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeSettingsArguments } from "pi-cosmic-core";
import { PiCommandAdapter, type PiCommandError } from "../boundary/host-commands.ts";
import {
  openAdvisorDashboard,
  openAdvisorSetup,
  showAdvisorUsage,
  updateConfig,
} from "./panels.ts";
import type {
  AdvisorCommandActions,
  AdvisorCommandRegistrar,
  AdvisorConfigState,
} from "./types.ts";

export {
  emptyAdvisorOutcomes,
  type AdvisorModelUsage,
  type AdvisorOutcomeMetrics,
  type AdvisorSessionMetrics,
} from "../domain/metrics.ts";
export type {
  AdvisorCommandActions,
  AdvisorCommandRegistrar,
  AdvisorConfigState,
  AdvisorReviewRequestResult,
} from "./types.ts";

const ADVISOR_COMMAND = "advisor";
export const ADVISOR_COMMAND_DESCRIPTION = "Advisor controls, review, and usage";
const SUBCOMMANDS = ["on", "off", "review", "fix", "dismiss", "cancel", "setup", "usage"] as const;
const SUBCOMMAND_DESCRIPTIONS: Readonly<Record<(typeof SUBCOMMANDS)[number], string>> = {
  on: "Enable the advisor",
  off: "Disable the advisor",
  review: "Review the last completed response",
  fix: "Send guidance for the open advisor card",
  dismiss: "Dismiss the open advisor card",
  cancel: "Cancel pending advisor work",
  setup: "Choose the advisor model",
  usage: "Show advisor usage and outcomes",
};

export function registerAdvisorCommands(
  pi: AdvisorCommandRegistrar,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions,
  runCommand?: <A>(effect: Effect.Effect<A, PiCommandError, PiCommandAdapter>) => Promise<A>,
): void {
  const execute = (operation: () => Promise<void>): Promise<void> =>
    runCommand
      ? runCommand(
          Effect.gen(function* () {
            const adapter = yield* PiCommandAdapter;
            return yield* adapter.fromPromise(operation);
          }),
        ).catch(() => undefined)
      : operation();
  pi.registerCommand(ADVISOR_COMMAND, {
    description: ADVISOR_COMMAND_DESCRIPTION,
    getArgumentCompletions: (prefix) =>
      completeSettingsArguments(
        prefix,
        [],
        SUBCOMMANDS.map((value) => ({
          value,
          label: value,
          description: SUBCOMMAND_DESCRIPTIONS[value],
        })),
      ),
    handler: (args, ctx) => execute(() => handleAdvisorCommand(args, ctx, state, actions)),
  });
}

async function handleAdvisorCommand(
  args: string,
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions,
): Promise<void> {
  const command = args.trim().toLowerCase();
  if (!command) return openAdvisorDashboard(ctx, state, actions);
  if (command === "review") {
    const unavailable = manualReviewUnavailableReason(ctx, state);
    if (unavailable) return ctx.ui.notify(unavailable, "warning");
    const result = await actions.reviewLast(ctx);
    ctx.ui.notify(reviewRequestMessage(result), result === "started" ? "info" : "warning");
  } else if (command === "fix") {
    notifyCardAction(ctx, actions.fixLast(ctx), "fixed");
  } else if (command === "dismiss") {
    notifyCardAction(ctx, actions.dismissLast(ctx), "dismissed");
  } else if (command === "cancel") {
    const cancelled = await actions.cancel(ctx);
    ctx.ui.notify(
      cancelled ? "Cancelled pending Advisor work." : "No Advisor review is active.",
      "info",
    );
  } else if (command === "on") {
    if (!advisorModelReady(ctx, state.get())) return openAdvisorSetup(ctx, state);
    if (await updateConfig(ctx, state, { enabled: true })) ctx.ui.notify("Advisor is on.", "info");
  } else if (command === "off") {
    if (await updateConfig(ctx, state, { enabled: false }))
      ctx.ui.notify("Advisor is off.", "info");
  } else if (command === "setup") await openAdvisorSetup(ctx, state);
  else if (command === "usage") showAdvisorUsage(ctx, state.get(), state.getMetrics());
  else ctx.ui.notify(`Usage: /advisor [${SUBCOMMANDS.join("|")}]`, "error");
}

function manualReviewUnavailableReason(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
): string | undefined {
  if (!advisorModelReady(ctx, state.get()))
    return "Advisor needs an available authenticated model. Run /advisor setup.";
  return undefined;
}

function advisorModelReady(
  ctx: ExtensionCommandContext,
  config: ReturnType<AdvisorConfigState["get"]>,
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

function notifyCardAction(
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
