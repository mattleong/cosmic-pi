import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { selectAtHostCommandBoundary, type PiCommandError } from "../boundary/host-commands.ts";
import { selectAdvisorOnboardingAtHostBoundary } from "../boundary/host-onboarding.ts";
import { latestOpenAdvisorReviewCardAtHostBoundary } from "../boundary/host-review-cards.ts";
import { type AdvisorConfigPatch, type ResolvedAdvisorConfig } from "../config/options.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";
import { formatLastReview, formatModel, formatUsageDuration } from "./format.ts";
import { notifyCardAction } from "./notify.ts";
import type {
  AdvisorCommandActions,
  AdvisorCommandSnapshot,
  AdvisorCommandState,
} from "./types.ts";

export function openAdvisorDashboard(
  ctx: ExtensionCommandContext,
  state: AdvisorCommandState,
  actions: AdvisorCommandActions,
): Effect.Effect<void, PiCommandError> {
  return Effect.suspend(() => {
    const snapshot = state.snapshot;
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
        if (choice === "Review last")
          return actions.reviewLast(ctx).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                ctx.ui.notify(
                  result === "started"
                    ? "Advisor review started."
                    : result === "unavailable"
                      ? "No completed response is available to review."
                      : "Advisor review could not start. Try again.",
                  result === "started" ? "info" : "warning",
                ),
              ),
            ),
            Effect.asVoid,
          );
        if (choice === "Fix last")
          return Effect.sync(() => notifyCardAction(ctx, actions.fixLast(ctx), "fixed"));
        if (choice === "Dismiss last")
          return Effect.sync(() => notifyCardAction(ctx, actions.dismissLast(ctx), "dismissed"));
        if (choice === "Cancel review")
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
        if (choice === "Turn on")
          return updateConfig(ctx, state, { enabled: true }).pipe(
            Effect.tap((updated) =>
              updated ? Effect.sync(() => ctx.ui.notify("Advisor is on.", "info")) : Effect.void,
            ),
            Effect.asVoid,
          );
        if (choice === "Turn off")
          return updateConfig(ctx, state, { enabled: false }).pipe(
            Effect.tap((updated) =>
              updated ? Effect.sync(() => ctx.ui.notify("Advisor is off.", "info")) : Effect.void,
            ),
            Effect.asVoid,
          );
        if (choice === "Usage") return Effect.sync(() => showAdvisorUsage(ctx, snapshot.metrics));
        return Effect.void;
      }),
    );
  });
}

/** Setup always opens when explicitly requested. One persistence patch commits each choice atomically. */
export function openAdvisorSetup(
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

export function updateConfig(
  ctx: ExtensionCommandContext,
  state: AdvisorCommandState,
  patch: AdvisorConfigPatch,
): Effect.Effect<boolean> {
  const path = state.snapshot.config.configPath;
  return state.persist(patch, path).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.sync(() => {
        ctx.ui.notify(`Could not save advisor settings: ${error.message}`, "error");
        return false;
      }),
    ),
  );
}

export function showAdvisorStatus(
  ctx: ExtensionCommandContext,
  snapshot: AdvisorCommandSnapshot,
): void {
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

export function showAdvisorUsage(
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
