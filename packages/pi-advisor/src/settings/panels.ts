// Pi's settings UI is Promise-shaped by contract.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { selectAdvisorOnboardingAtHostBoundary } from "../boundary/host-onboarding.ts";
import { latestOpenAdvisorReviewCardAtHostBoundary } from "../boundary/host-review-cards.ts";
import { type AdvisorConfigPatch, type ResolvedAdvisorConfig } from "../config/options.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";
import { formatLastReview, formatModel, formatUsageDuration } from "./format.ts";
import type { AdvisorCommandActions, AdvisorConfigState } from "./types.ts";

export async function openAdvisorDashboard(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions,
): Promise<void> {
  if (ctx.mode !== "tui") {
    showAdvisorStatus(ctx, state.get(), state.getMetrics());
    return;
  }
  const config = state.get();
  const metrics = state.getMetrics();
  const hasOpenCard = Boolean(latestOpenAdvisorReviewCardAtHostBoundary(ctx));
  const stateLabel = advisorEffectiveState(ctx, config);
  const modelReady = stateLabel === "ready" || stateLabel === "disabled";
  const reviewActive =
    (metrics.backgroundState !== undefined && metrics.backgroundState !== "idle") ||
    (metrics.queuedReviews ?? 0) > 0;
  const choices = [
    modelReady ? "Change model" : "Set up Advisor",
    ...(modelReady && metrics.hasLastCandidate ? ["Review last"] : []),
    ...(hasOpenCard ? ["Fix last", "Dismiss last"] : []),
    ...(reviewActive ? ["Cancel review"] : []),
    ...(config.enabled ? ["Turn off"] : modelReady ? ["Turn on"] : []),
    "Usage",
    "Done",
  ];
  const choice = await ctx.ui.select(
    `Advisor · ${stateLabel} · ${formatModel(config)} · ${formatLastReview(metrics)} · ${(metrics.totalTokens ?? 0).toLocaleString()} tokens · $${(metrics.cost ?? 0).toFixed(4)}`,
    choices,
  );
  if (choice === "Set up Advisor" || choice === "Change model") await openAdvisorSetup(ctx, state);
  else if (choice === "Review last") {
    const result = await actions.reviewLast(ctx);
    ctx.ui.notify(
      result === "started"
        ? "Advisor review started."
        : result === "unavailable"
          ? "No completed response is available to review."
          : "Advisor review could not start. Try again.",
      result === "started" ? "info" : "warning",
    );
  } else if (choice === "Fix last") notifyDashboardCardAction(ctx, actions.fixLast(ctx), "fixed");
  else if (choice === "Dismiss last")
    notifyDashboardCardAction(ctx, actions.dismissLast(ctx), "dismissed");
  else if (choice === "Cancel review") {
    const cancelled = await actions.cancel(ctx);
    ctx.ui.notify(
      cancelled ? "Cancelled pending Advisor work." : "No Advisor review is active.",
      "info",
    );
  } else if (choice === "Turn on") {
    if (await updateConfig(ctx, state, { enabled: true })) ctx.ui.notify("Advisor is on.", "info");
  } else if (choice === "Turn off") {
    if (await updateConfig(ctx, state, { enabled: false }))
      ctx.ui.notify("Advisor is off.", "info");
  } else if (choice === "Usage") showAdvisorUsage(ctx, state.get(), state.getMetrics());
}

/** Setup always opens when explicitly requested. One persistence patch commits each choice atomically. */
export async function openAdvisorSetup(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Advisor setup requires interactive TUI mode.", "error");
    return;
  }
  const selected = await selectAdvisorOnboardingAtHostBoundary(ctx);
  if (!selected) return;
  if (selected.type === "not-now") {
    await updateConfig(ctx, state, { setupDismissed: true });
    return;
  }
  await updateConfig(ctx, state, {
    provider: selected.provider,
    model: selected.model,
    enabled: true,
    setupDismissed: true,
  });
}

export function updateConfig(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  patch: AdvisorConfigPatch,
): Promise<boolean> {
  const path = state.get().configPath;
  return state.persist(patch, path).then(
    () => true,
    (error: unknown) => {
      ctx.ui.notify(
        `Could not save advisor settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    },
  );
}

export function showAdvisorStatus(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
  metrics: Readonly<AdvisorSessionMetrics>,
): void {
  const effective = advisorEffectiveState(ctx, config);
  ctx.ui.notify(
    [
      `Advisor: ${effective}`,
      `Model: ${formatModel(config)}`,
      `Activity: ${metrics.backgroundState ?? "idle"}`,
      `Last result: ${formatLastReview(metrics)}`,
    ].join("\n"),
    effective === "ready" ? "info" : "warning",
  );
}

export function showAdvisorUsage(
  ctx: ExtensionCommandContext,
  _config: ResolvedAdvisorConfig,
  metrics: Readonly<AdvisorSessionMetrics>,
): void {
  const settled = metrics.settledReviews ?? 0;
  const corrections =
    metrics.outcomes.guidance + metrics.outcomes.revision + metrics.outcomes.recovery;
  ctx.ui.notify(
    [
      "Advisor usage · this session",
      `Responses/reviews/cards: ${metrics.modelResponses ?? 0} / ${settled} / ${metrics.cards ?? 0}`,
      `Corrections: ${corrections}`,
      `Tokens: ${(metrics.totalTokens ?? 0).toLocaleString()} · cost $${(metrics.cost ?? 0).toFixed(6)}`,
      `Timing: ${formatUsageDuration(metrics.totalDurationMs ?? 0)} total · ${formatUsageDuration(metrics.latestDurationMs ?? 0)} latest`,
    ].join("\n"),
    "info",
  );
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

function notifyDashboardCardAction(
  ctx: ExtensionCommandContext,
  result: ReturnType<AdvisorCommandActions["fixLast"]>,
  completed: "fixed" | "dismissed",
): void {
  if (result === "applied") ctx.ui.notify(`Advisor card ${completed}.`, "info");
  else if (result === "unavailable") ctx.ui.notify("No open Advisor card.", "warning");
  else if (result === "delivery-failed")
    ctx.ui.notify("Advisor could not send guidance; the card remains open.", "error");
  else
    ctx.ui.notify(
      completed === "fixed"
        ? "Guidance was sent, but Advisor could not mark the card fixed."
        : "Advisor could not mark the card dismissed.",
      "error",
    );
}
