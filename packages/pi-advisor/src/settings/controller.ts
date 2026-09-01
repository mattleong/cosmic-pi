import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { completeSettingsArguments } from "pi-cosmic-core";
import { selectAtHostCommandBoundary, type PiCommandError } from "../boundary/host-commands.ts";
import { selectAdvisorOnboardingAtHostBoundary } from "../boundary/host-onboarding.ts";
import { latestOpenAdvisorReviewCardAtHostBoundary } from "../boundary/host-review-cards.ts";
import type { AdvisorConfigPatch, ResolvedAdvisorConfig } from "../config/options.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";
import { formatLastReview, formatModel, formatUsageDuration } from "./format.ts";
import type {
  AdvisorCommandActions,
  AdvisorCommandSnapshot,
  AdvisorCommandState,
} from "./types.ts";

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
    const snapshot = state.snapshot;
    const command = args.trim().toLowerCase();
    if (!command) return openAdvisorDashboard(ctx, state, actions);
    if (command === "review")
      return requestReview(ctx, actions, advisorModelReady(ctx, snapshot.config));
    if (command === "fix") return applyCardAction(ctx, actions, "fix");
    if (command === "dismiss") return applyCardAction(ctx, actions, "dismiss");
    if (command === "cancel") return cancelReview(ctx, actions);
    if (command === "on") {
      if (!advisorModelReady(ctx, snapshot.config)) return openAdvisorSetup(ctx, state);
      return setAdvisorEnabled(ctx, state, true);
    }
    if (command === "off") return setAdvisorEnabled(ctx, state, false);
    if (command === "setup") return openAdvisorSetup(ctx, state);
    if (command === "usage") return Effect.sync(() => showAdvisorUsage(ctx, snapshot.metrics));
    return Effect.sync(() => ctx.ui.notify(`Usage: /advisor [${SUBCOMMANDS.join("|")}]`, "error"));
  });
}

function openAdvisorDashboard(
  ctx: ExtensionCommandContext,
  state: AdvisorCommandState,
  actions: AdvisorCommandActions,
): Effect.Effect<void, PiCommandError> {
  return Effect.suspend(() => {
    const { snapshot } = state;
    if (ctx.mode !== "tui") {
      showAdvisorStatus(ctx, snapshot);
      return Effect.void;
    }
    const { activity, config, hasLastCandidate, metrics } = snapshot;
    const hasOpenCard = Boolean(latestOpenAdvisorReviewCardAtHostBoundary(ctx));
    const stateLabel = advisorEffectiveState(ctx, config);
    const modelReady = stateLabel === "ready" || stateLabel === "disabled";
    const reviewActive = activity !== "idle";
    const choices = [
      modelReady ? "Change model" : "Set up Advisor",
      ...(modelReady && hasLastCandidate ? ["Review last"] : []),
      ...(hasOpenCard ? ["Fix last", "Dismiss last"] : []),
      ...(reviewActive ? ["Cancel review"] : []),
      ...(config.enabled ? ["Turn off"] : modelReady ? ["Turn on"] : []),
      "Usage",
      "Done",
    ];
    return selectAtHostCommandBoundary(
      ctx,
      `Advisor · ${stateLabel} · ${formatModel(config)} · ${formatLastReview(metrics)} · ${metrics.totalTokens.toLocaleString()} tokens · $${metrics.cost.toFixed(4)}`,
      choices,
    ).pipe(
      Effect.flatMap((choice) => {
        if (choice === "Set up Advisor" || choice === "Change model")
          return openAdvisorSetup(ctx, state);
        if (choice === "Review last") return requestReview(ctx, actions, modelReady);
        if (choice === "Fix last") return applyCardAction(ctx, actions, "fix");
        if (choice === "Dismiss last") return applyCardAction(ctx, actions, "dismiss");
        if (choice === "Cancel review") return cancelReview(ctx, actions);
        if (choice === "Turn on") return setAdvisorEnabled(ctx, state, true);
        if (choice === "Turn off") return setAdvisorEnabled(ctx, state, false);
        if (choice === "Usage") return Effect.sync(() => showAdvisorUsage(ctx, snapshot.metrics));
        return Effect.void;
      }),
    );
  });
}

/** Setup always opens when explicitly requested. One persistence patch commits each choice atomically. */
function openAdvisorSetup(
  ctx: ExtensionCommandContext,
  state: AdvisorCommandState,
): Effect.Effect<void, PiCommandError> {
  if (ctx.mode !== "tui")
    return Effect.sync(() =>
      ctx.ui.notify("Advisor setup requires interactive TUI mode.", "error"),
    );
  return selectAdvisorOnboardingAtHostBoundary(ctx).pipe(
    Effect.flatMap((selected) => {
      if (!selected) return Effect.void;
      if (selected.type === "not-now")
        return updateConfig(ctx, state, { setupDismissed: true }).pipe(Effect.asVoid);
      return updateConfig(ctx, state, {
        provider: selected.provider,
        model: selected.model,
        enabled: true,
        setupDismissed: true,
      }).pipe(Effect.asVoid);
    }),
  );
}

function requestReview(
  ctx: ExtensionCommandContext,
  actions: AdvisorCommandActions,
  modelReady: boolean,
): Effect.Effect<void> {
  if (!modelReady)
    return Effect.sync(() =>
      ctx.ui.notify(
        "Advisor needs an available authenticated model. Run /advisor setup.",
        "warning",
      ),
    );
  return actions.reviewLast(ctx).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        ctx.ui.notify(reviewRequestMessage(result), result === "started" ? "info" : "warning"),
      ),
    ),
    Effect.asVoid,
  );
}

function applyCardAction(
  ctx: ExtensionCommandContext,
  actions: AdvisorCommandActions,
  action: "fix" | "dismiss",
): Effect.Effect<void> {
  return Effect.sync(() => {
    const result = action === "fix" ? actions.fixLast(ctx) : actions.dismissLast(ctx);
    notifyCardAction(ctx, result, action === "fix" ? "fixed" : "dismissed");
  });
}

function cancelReview(
  ctx: ExtensionCommandContext,
  actions: AdvisorCommandActions,
): Effect.Effect<void> {
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
}

function setAdvisorEnabled(
  ctx: ExtensionCommandContext,
  state: AdvisorCommandState,
  enabled: boolean,
): Effect.Effect<void> {
  return updateConfig(ctx, state, { enabled }).pipe(
    Effect.tap((updated) =>
      updated
        ? Effect.sync(() => ctx.ui.notify(enabled ? "Advisor is on." : "Advisor is off.", "info"))
        : Effect.void,
    ),
    Effect.asVoid,
  );
}

function updateConfig(
  ctx: ExtensionCommandContext,
  state: AdvisorCommandState,
  patch: AdvisorConfigPatch,
): Effect.Effect<boolean> {
  return state.persist(patch, state.snapshot.config.configPath).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.sync(() => {
        ctx.ui.notify(`Could not save advisor settings: ${error.message}`, "error");
        return false;
      }),
    ),
  );
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

function showAdvisorStatus(ctx: ExtensionCommandContext, snapshot: AdvisorCommandSnapshot): void {
  const effective = advisorEffectiveState(ctx, snapshot.config);
  ctx.ui.notify(
    [
      `Advisor: ${effective}`,
      `Model: ${formatModel(snapshot.config)}`,
      `Activity: ${snapshot.activity}`,
      `Last result: ${formatLastReview(snapshot.metrics)}`,
    ].join("\n"),
    effective === "ready" ? "info" : "warning",
  );
}

function showAdvisorUsage(
  ctx: ExtensionCommandContext,
  metrics: Readonly<AdvisorSessionMetrics>,
): void {
  ctx.ui.notify(
    [
      "Advisor usage · this session",
      `Responses/reviews/cards: ${metrics.modelResponses} / ${metrics.settledReviews} / ${metrics.cards}`,
      `Corrections: ${metrics.corrections}`,
      `Tokens: ${metrics.totalTokens.toLocaleString()} · cost $${metrics.cost.toFixed(6)}`,
      `Timing: ${formatUsageDuration(metrics.totalDurationMs)} total · ${formatUsageDuration(metrics.latestDurationMs ?? 0)} latest`,
    ].join("\n"),
    "info",
  );
}

function advisorModelReady(ctx: ExtensionCommandContext, config: ResolvedAdvisorConfig): boolean {
  if (!config.provider || !config.model) return false;
  const model = ctx.modelRegistry.find(config.provider, config.model);
  return Boolean(model && ctx.modelRegistry.hasConfiguredAuth(model));
}

function advisorEffectiveState(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
): string {
  if (!config.provider || !config.model) return "setup required";
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) return "model unavailable";
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return "credentials required";
  return config.enabled ? "ready" : "disabled";
}

function reviewRequestMessage(result: "started" | "unavailable" | "cancelled"): string {
  if (result === "started") return "Advisor review started.";
  if (result === "unavailable") return "No completed response is available to review.";
  return "Advisor review could not start. Try again.";
}
