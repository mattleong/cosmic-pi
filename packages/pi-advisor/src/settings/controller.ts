// Promise-shaped Pi command handlers are an explicit host boundary.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeSettingsArguments } from "pi-cosmic-core";
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
import { notifyCardAction } from "./notify.ts";

export type { AdvisorCommandActions } from "./types.ts";

const ADVISOR_COMMAND = "advisor";
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

export function registerAdvisorCommands(
  pi: AdvisorCommandRegistrar,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions,
): void {
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
    handler: (args, ctx) => handleAdvisorCommand(args, ctx, state, actions),
  });
}

function handleAdvisorCommand(
  args: string,
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions,
): Promise<void> {
  const command = args.trim().toLowerCase();
  if (!command) return openAdvisorDashboard(ctx, state, actions);
  if (command === "review") {
    const unavailable = manualReviewUnavailableReason(ctx, state);
    if (unavailable) return Promise.resolve(ctx.ui.notify(unavailable, "warning"));
    return Promise.resolve(actions.reviewLast(ctx)).then((result) =>
      ctx.ui.notify(reviewRequestMessage(result), result === "started" ? "info" : "warning"),
    );
  }
  if (command === "fix")
    return Promise.resolve(notifyCardAction(ctx, actions.fixLast(ctx), "fixed"));
  if (command === "dismiss")
    return Promise.resolve(notifyCardAction(ctx, actions.dismissLast(ctx), "dismissed"));
  if (command === "cancel")
    return Promise.resolve(actions.cancel(ctx)).then((cancelled) =>
      ctx.ui.notify(
        cancelled ? "Cancelled pending Advisor work." : "No Advisor review is active.",
        "info",
      ),
    );
  if (command === "on") {
    if (!advisorModelReady(ctx, state.get())) return openAdvisorSetup(ctx, state);
    return updateConfig(ctx, state, { enabled: true }).then((updated) => {
      if (updated) ctx.ui.notify("Advisor is on.", "info");
    });
  }
  if (command === "off")
    return updateConfig(ctx, state, { enabled: false }).then((updated) => {
      if (updated) ctx.ui.notify("Advisor is off.", "info");
    });
  if (command === "setup") return openAdvisorSetup(ctx, state);
  if (command === "usage")
    return Promise.resolve(showAdvisorUsage(ctx, state.get(), state.getMetrics()));
  return Promise.resolve(ctx.ui.notify(`Usage: /advisor [${SUBCOMMANDS.join("|")}]`, "error"));
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
