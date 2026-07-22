import * as Effect from "effect/Effect";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CLEAR_MODEL_OPTION } from "../config/model-picker.ts";
import { PiCommandAdapter, type PiCommandError } from "../boundary/host-commands.ts";
import { formatDuration, formatFastMode, formatModel, formatPolicy } from "./format.ts";
import {
  openAdvisorDashboard,
  openAdvisorSettings,
  showAdvisorStatus,
  showAdvisorUsage,
  isVerbose,
  updateConfig,
  CONTEXT_OPTIONS,
  POLICY_OPTIONS,
  THINKING_LEVELS,
  TIMEOUT_OPTIONS,
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

const SETTINGS_COMMAND = "advisor-settings";
const STATUS_COMMAND = "advisor-status";
const USAGE_COMMAND = "advisor-usage";
const ADVISOR_COMMAND = "advisor";

const NOOP_COMMAND_ACTIONS: AdvisorCommandActions = {
  cancel: () => false,
  pause: () => {},
  resume: () => {},
  reviewLast: () => "unavailable",
  reviewNext: () => {},
};

export function registerAdvisorCommands(
  pi: AdvisorCommandRegistrar,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions = NOOP_COMMAND_ACTIONS,
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
    description: "Control advisor review",
    getArgumentCompletions: (prefix) => {
      const values = [
        "once",
        "review-last",
        "verify-last",
        "pause",
        "resume",
        "cancel",
        "on",
        "off",
        "settings",
        "status",
        "status --verbose",
      ];
      const matches = values
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: (args, ctx) => execute(() => handleAdvisorCommand(args, ctx, state, actions)),
  });
  pi.registerCommand(SETTINGS_COMMAND, {
    description: "Configure automatic advisor supervision",
    handler: (_args, ctx) => execute(() => openAdvisorSettings(ctx, state)),
  });
  pi.registerCommand(STATUS_COMMAND, {
    description: "Show advisor model and configuration status",
    handler: (args, ctx) => {
      showAdvisorStatus(ctx, state.get(), state.getMetrics(), isVerbose(args));
      return Promise.resolve();
    },
  });
  pi.registerCommand(USAGE_COMMAND, {
    description: "Show advisor usage for this session",
    handler: (_args, ctx) => {
      showAdvisorUsage(ctx, state.get(), state.getMetrics());
      return Promise.resolve();
    },
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
  if (command === "once") {
    actions.reviewNext(ctx);
    ctx.ui.notify("Advisor will review the next completed response.", "info");
    return Promise.resolve();
  }
  if (command === "review-last" || command === "verify-last") {
    const focus = command === "verify-last" ? "verification" : "standard";
    return Promise.resolve(actions.reviewLast(ctx, focus)).then((result) => {
      if (result === "unavailable")
        ctx.ui.notify("No completed response is available to review.", "warning");
      else if (result === "started")
        ctx.ui.notify(
          focus === "verification"
            ? "Started an evidence-focused transcript review of the last response."
            : "Started a review of the last response.",
          "info",
        );
    });
  }
  if (command === "pause") {
    actions.pause(ctx);
    ctx.ui.notify("Advisor paused for this session.", "info");
    return Promise.resolve();
  }
  if (command === "resume") {
    actions.resume(ctx);
    ctx.ui.notify("Advisor resumed for this session.", "info");
    return Promise.resolve();
  }
  if (command === "cancel") {
    return Promise.resolve(actions.cancel(ctx)).then((cancelled) => {
      ctx.ui.notify(
        cancelled ? "Cancelled pending advisor work." : "No advisor review is active.",
        "info",
      );
    });
  }
  if (command === "on" || command === "off") {
    const enabled = command === "on";
    return updateConfig(ctx, state, { enabled }).then((saved) => {
      if (saved)
        ctx.ui.notify(`Automatic advisor review ${enabled ? "enabled" : "disabled"}.`, "info");
    });
  }
  if (command === "settings") return openAdvisorSettings(ctx, state);
  if (command === "status" || command === "status --verbose" || command === "status -v") {
    showAdvisorStatus(ctx, state.get(), state.getMetrics(), command !== "status");
    return Promise.resolve();
  }
  ctx.ui.notify(
    "Usage: /advisor [once|review-last|verify-last|pause|resume|cancel|on|off|settings|status [--verbose]]",
    "error",
  );
  return Promise.resolve();
}

export const _settingsTest = {
  CLEAR_MODEL_OPTION,
  CONTEXT_OPTIONS,
  POLICY_OPTIONS,
  THINKING_LEVELS,
  TIMEOUT_OPTIONS,
  formatDuration,
  formatFastMode,
  formatModel,
  formatPolicy,
};
