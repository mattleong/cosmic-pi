import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { supportsFastModel } from "pi-better-openai/fast-models";
import { CLEAR_MODEL_OPTION, selectAdvisorModel } from "../config/model-picker.ts";
import {
  ADVISOR_THINKING_LEVELS,
  type AdvisorConfigPatch,
  type AdvisorReviewPolicy,
  type ResolvedAdvisorConfig,
} from "../config/options.ts";
import { writeAdvisorConfigPatchAsync } from "../config/store.ts";
import { safeAdvisorLabel } from "../domain/label.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";
import { getAdvisorFailureLogPath } from "../logging/log.ts";
import { MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST } from "../review/intervention-budget.ts";
import { isOneOf } from "../shared/utils.ts";
import {
  formatDuration,
  formatFastMode,
  formatLastReview,
  formatList,
  formatModel,
  formatPercent,
  formatPolicy,
  formatSkippedReviews,
  formatUsageDuration,
} from "./format.ts";
import type { AdvisorCommandActions, AdvisorConfigState } from "./types.ts";

const TIMEOUT_OPTIONS = [10_000, 30_000, 60_000, 90_000, 120_000, 180_000] as const;
const CONTEXT_OPTIONS = [16_000, 48_000, 120_000, 240_000] as const;
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ADVISOR_THINKING_LEVELS;

const POLICY_OPTIONS: Array<{ label: string; value: AdvisorReviewPolicy }> = [
  { label: "Corrective (recommended)", value: "corrective" },
  { label: "Guardrail", value: "guardrail" },
  { label: "Advisory", value: "advisory" },
];

export function openAdvisorDashboard(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions,
): Promise<void> {
  if (!ctx.hasUI) {
    showAdvisorStatus(ctx, state.get(), state.getMetrics(), false);
    return Promise.resolve();
  }
  const config = state.get();
  const metrics = state.getMetrics();
  const pauseOption = metrics.paused ? "Resume for this session" : "Pause for this session";
  const enableOption = config.enabled ? "Turn automatic review off" : "Turn automatic review on";
  const choices = [
    "Review next response",
    ...(metrics.hasLastCandidate ? ["Review last response", "Verify last response"] : []),
    pauseOption,
    enableOption,
    "Settings",
    "Status",
    "Done",
  ];
  return ctx.ui
    .select(
      `Advisor · ${formatPolicy(config.reviewPolicy)} · persistent read-only · ${formatModel(config)}`,
      choices,
    )
    .then((choice) => {
      if (choice === "Review next response") {
        actions.reviewNext(ctx);
        ctx.ui.notify("Advisor will review the next completed response.", "info");
      } else if (choice === "Review last response" || choice === "Verify last response") {
        const focus = choice === "Verify last response" ? "verification" : "standard";
        return Promise.resolve(actions.reviewLast(ctx, focus)).then((result) => {
          if (result)
            ctx.ui.notify(
              focus === "verification"
                ? "Started an evidence-focused transcript review."
                : "Started review.",
              "info",
            );
        });
      } else if (choice === pauseOption) {
        if (metrics.paused) actions.resume(ctx);
        else actions.pause(ctx);
      } else if (choice === enableOption)
        return updateConfig(ctx, state, { enabled: !config.enabled }).then(() => undefined);
      else if (choice === "Settings") return openAdvisorSettings(ctx, state);
      else if (choice === "Status") showAdvisorStatus(ctx, state.get(), state.getMetrics(), false);
      return undefined;
    });
}

export function openAdvisorSettings(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/advisor-settings requires interactive UI.", "error");
    return Promise.resolve();
  }
  const step = (): Promise<void> => {
    const current = state.get();
    const enabledOption = `Advisor supervision: ${current.enabled ? "on" : "off"}`;
    const policyOption = `Behavior: ${formatPolicy(current.reviewPolicy)}`;
    const modelOption = `Advisor model: ${formatModel(current)}`;
    const fastModeOption = `OpenAI fast mode: ${current.fastMode ? "on" : "off"}`;
    const thinkingOption = `Reasoning level: ${current.thinkingLevel}`;
    const timeoutOption = `Advisor operation timeout: ${formatDuration(current.timeoutMs)}`;
    const contextOption = `Context cap: ${current.maxContextChars.toLocaleString()} characters`;
    return ctx.ui
      .select("Advisor settings · changes apply immediately", [
        enabledOption,
        policyOption,
        modelOption,
        fastModeOption,
        thinkingOption,
        timeoutOption,
        contextOption,
        "Done",
      ])
      .then((choice) => {
        if (!choice || choice === "Done") return false;
        if (choice === enabledOption)
          return updateConfig(ctx, state, { enabled: !current.enabled }).then(() => true);
        if (choice === policyOption)
          return choosePolicy(ctx, current.reviewPolicy).then((next) =>
            next && next !== current.reviewPolicy
              ? updateConfig(ctx, state, { reviewPolicy: next }).then(() => true)
              : true,
          );
        if (choice === modelOption)
          return chooseAdvisorModel(ctx, current).then((next) =>
            next.provider !== current.provider ||
            next.model !== current.model ||
            next.thinkingLevel !== current.thinkingLevel
              ? updateConfig(ctx, state, {
                  provider: next.provider,
                  model: next.model,
                  thinkingLevel: next.thinkingLevel,
                }).then(() => true)
              : true,
          );
        if (choice === fastModeOption)
          return updateConfig(ctx, state, { fastMode: !current.fastMode }).then(() => true);
        if (choice === thinkingOption)
          return chooseThinkingLevel(ctx, current).then((value) =>
            value && value !== current.thinkingLevel
              ? updateConfig(ctx, state, { thinkingLevel: value }).then(() => true)
              : true,
          );
        if (choice === timeoutOption)
          return chooseNumericSetting(
            ctx,
            "Advisor operation timeout",
            TIMEOUT_OPTIONS.map((item) => ({ label: formatDuration(item), value: item })),
          ).then((value) =>
            value !== undefined && value !== current.timeoutMs
              ? updateConfig(ctx, state, { timeoutMs: value }).then(() => true)
              : true,
          );
        return chooseNumericSetting(
          ctx,
          "Advisor context cap",
          CONTEXT_OPTIONS.map((item) => ({
            label: `${item.toLocaleString()} characters`,
            value: item,
          })),
        ).then((value) =>
          value !== undefined && value !== current.maxContextChars
            ? updateConfig(ctx, state, { maxContextChars: value }).then(() => true)
            : true,
        );
      })
      .then((continueEditing) => (continueEditing === false ? undefined : step()));
  };
  return step();
}

export function choosePolicy(
  ctx: ExtensionCommandContext,
  current: AdvisorReviewPolicy,
): Promise<AdvisorReviewPolicy | undefined> {
  const labels = POLICY_OPTIONS.map(({ label, value }) =>
    value === current ? `${label} (current)` : label,
  );
  return ctx.ui.select("Advisor behavior", labels).then((selected) => {
    const normalized = selected?.replace(" (current)", "");
    return POLICY_OPTIONS.find(({ label }) => label === normalized)?.value;
  });
}

export function chooseAdvisorModel(
  ctx: ExtensionCommandContext,
  draft: ResolvedAdvisorConfig,
): Promise<ResolvedAdvisorConfig> {
  const models = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({ label: `${model.provider}/${model.id}`, model }))
    .sort((left, right) => left.label.localeCompare(right.label));
  if (models.length === 0) {
    if (draft.configured) {
      return ctx.ui
        .select("Dedicated advisor model", [CLEAR_MODEL_OPTION])
        .then((selection) =>
          selection === CLEAR_MODEL_OPTION
            ? { ...draft, provider: undefined, model: undefined, configured: false }
            : draft,
        );
    }
    ctx.ui.notify(
      "No authenticated models are available. Configure a provider in pi first.",
      "warning",
    );
    return Promise.resolve(draft);
  }

  return selectAdvisorModel(
    ctx,
    models.map(({ model }) => model),
    draft,
  ).then((selection) => {
    if (!selection) return draft;
    if (selection === CLEAR_MODEL_OPTION)
      return { ...draft, provider: undefined, model: undefined, configured: false };
    const selected = models.find(({ label }) => label === selection)?.model;
    if (!selected) return draft;
    return {
      ...draft,
      provider: selected.provider,
      model: selected.id,
      configured: true,
      thinkingLevel: clampThinkingLevel(selected, draft.thinkingLevel),
    };
  });
}

export function chooseThinkingLevel(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
): Promise<ModelThinkingLevel | undefined> {
  const model =
    config.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : undefined;
  const levels = model ? getSupportedThinkingLevels(model) : THINKING_LEVELS;
  return ctx.ui
    .select("Advisor reasoning level", [...levels])
    .then((selection) => (isOneOf(selection, THINKING_LEVELS) ? selection : undefined));
}

export function chooseNumericSetting(
  ctx: ExtensionCommandContext,
  title: string,
  options: Array<{ label: string; value: number }>,
): Promise<number | undefined> {
  return ctx.ui
    .select(
      title,
      options.map(({ label }) => label),
    )
    .then((selected) => options.find(({ label }) => label === selected)?.value);
}

export function updateConfig(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  patch: AdvisorConfigPatch,
): Promise<boolean> {
  const path = state.get().configPath;
  return (
    state.persist
      ? state.persist(patch, path).then(() => true)
      : writeAdvisorConfigPatchAsync(patch, path).then((next) =>
          Promise.resolve(state.update(next)).then(() => true),
        )
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not save advisor settings: ${message}`, "error");
    return false;
  });
}

export function showAdvisorUsage(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
  metrics: Readonly<AdvisorSessionMetrics>,
): void {
  const model =
    config.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : undefined;
  const reasoning = model ? clampThinkingLevel(model, config.thinkingLevel) : config.thinkingLevel;
  const mode =
    config.fastMode && supportsFastModel(config.provider, config.model) ? "fast" : "standard";
  const settled = metrics.settledReviews ?? 0;
  const inProgress = Math.max(0, metrics.attempted - settled);
  const totalDuration = metrics.totalDurationMs ?? 0;
  const reviewTime = settled
    ? `${formatUsageDuration(totalDuration)} total · ${formatUsageDuration(totalDuration / settled)} average · ${formatUsageDuration(metrics.latestDurationMs ?? 0)} latest`
    : "not available";
  const outcomes = metrics.outcomes;
  const perspective = outcomes.perspective ?? 0;
  const evaluated = outcomes.pass + perspective + outcomes.findings;
  const delivered = outcomes.advice + outcomes.guidance + outcomes.revision + outcomes.recovery;
  const lines = [
    "Advisor usage · this session",
    "",
    `Current model: ${formatModel(config)} · ${reasoning} · ${mode}`,
    `Model responses: ${(metrics.modelResponses ?? 0).toLocaleString()}`,
    `Reviews: ${metrics.attempted.toLocaleString()} attempted · ${settled.toLocaleString()} settled · ${inProgress.toLocaleString()} in progress`,
    "Calibration outcomes",
    `  Evaluated: ${evaluated.toLocaleString()}`,
    `  Pass: ${outcomes.pass.toLocaleString()} (${formatPercent(outcomes.pass, evaluated)})`,
    `  Perspective delivered: ${perspective.toLocaleString()} (${formatPercent(perspective, evaluated)})`,
    `  Finding reviews: ${outcomes.findings.toLocaleString()} (${formatPercent(outcomes.findings, evaluated)})`,
    `  Delivered: ${delivered.toLocaleString()} (${formatPercent(delivered, outcomes.findings)} of finding reviews)`,
    `    Advice ${outcomes.advice.toLocaleString()} · guidance ${outcomes.guidance.toLocaleString()} · revision ${outcomes.revision.toLocaleString()} · recovery ${outcomes.recovery.toLocaleString()}`,
    `  Suppressed: ${outcomes.suppressed.toLocaleString()} (${formatPercent(outcomes.suppressed, outcomes.findings)} of finding reviews)`,
    `  Discarded: ${outcomes.discarded.toLocaleString()} · failures ${outcomes.failures.toLocaleString()}`,
    `  Verification reviews: ${(metrics.blockerVerificationAttempts ?? 0).toLocaleString()} attempted · blocker fingerprints ${(metrics.blockersVerified ?? 0).toLocaleString()} confirmed · ${(metrics.blockersRejected ?? 0).toLocaleString()} rejected`,
    `  Receipts: ${(metrics.interventionsAcknowledged ?? 0).toLocaleString()} of ${(metrics.interventionsDelivered ?? 0).toLocaleString()} delivered interventions`,
    `  Finding lifecycle: open ${(metrics.findingLifecycle?.open ?? 0).toLocaleString()} · acknowledged ${(metrics.findingLifecycle?.acknowledged ?? 0).toLocaleString()} · resolved ${(metrics.findingLifecycle?.resolved ?? 0).toLocaleString()} · superseded ${(metrics.findingLifecycle?.superseded ?? 0).toLocaleString()}`,
    `  Intervention budget: ${(metrics.interventionBudget?.delivered ?? 0).toLocaleString()}/${MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST.toLocaleString()} delivered · correction ${metrics.interventionBudget?.correctionUsed ? "used" : "available"}`,
    "",
    "Tokens",
    `  Input:        ${(metrics.inputTokens ?? 0).toLocaleString()}`,
    `  Output:       ${(metrics.outputTokens ?? 0).toLocaleString()}`,
    `  Cache read:   ${(metrics.cacheReadTokens ?? 0).toLocaleString()}`,
    `  Cache write:  ${(metrics.cacheWriteTokens ?? 0).toLocaleString()}`,
    `  Total:        ${(metrics.totalTokens ?? 0).toLocaleString()}`,
    "",
    `Reported cost: $${(metrics.cost ?? 0).toFixed(6)}`,
    `Review time: ${reviewTime}`,
  ];

  const modelUsage = Object.values(metrics.usageByModel ?? {}).sort(
    (left, right) => right.totalTokens - left.totalTokens,
  );
  if (modelUsage.length > 0) {
    lines.push("", "Models");
    for (const usage of modelUsage) {
      const responseLabel = usage.responses === 1 ? "response" : "responses";
      lines.push(
        `  ${safeAdvisorLabel(usage.provider)}/${safeAdvisorLabel(usage.model)}: ${usage.responses.toLocaleString()} ${responseLabel} · ${usage.totalTokens.toLocaleString()} tokens · $${usage.cost.toFixed(6)}`,
      );
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export function showAdvisorStatus(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
  metrics: Readonly<AdvisorSessionMetrics>,
  verbose: boolean,
): void {
  const model =
    config.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : undefined;
  const credentials = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
  const sessionState = metrics.paused
    ? "paused"
    : metrics.reviewNext
      ? "next response requested"
      : (metrics.backgroundState ?? "idle");
  const lines = [
    `Advisor: ${config.enabled ? "on" : "off"} · ${formatPolicy(config.reviewPolicy)} · ${formatModel(config)}`,
    `Session: ${sessionState}`,
    `Model access: ${model && credentials ? "ready" : model ? "credentials required" : "model unavailable"}`,
    `Last advisor action: ${formatLastReview(metrics)}`,
    "Per-turn catch-up: fail open within 30s · tools: project-confined read/grep/find/ls",
  ];

  if (verbose) {
    const settled = metrics.settledReviews ?? 0;
    const inProgress = Math.max(0, metrics.attempted - settled);
    lines.push(
      "",
      `Configuration: ${config.configured ? "configured" : "model required"}`,
      `Reasoning level: ${config.thinkingLevel}`,
      `Effective reasoning level: ${model ? clampThinkingLevel(model, config.thinkingLevel) : "unknown"}`,
      `OpenAI fast mode: ${formatFastMode(config)}`,
      "Interruption immunity: fixed at 3 subsequently completed primary turns; blockers may bypass",
      "Conversation: persistent in-memory Advisor with compact parent-session resume ledger (no second raw transcript)",
      "Thinking: main thinking is forwarded when Pi exposes it; Advisor thinking remains in memory only",
      "Investigation: project-confined package-owned read, grep, find, ls; no process launch or mutation",
      `Background state: ${metrics.backgroundState ?? "idle"} (${metrics.queuedReviews ?? 0} checkpoints, ${metrics.backlog ?? 0} observations)`,
      `Sequence: processed ${(metrics.processedSequence ?? 0).toLocaleString()} / ${(metrics.sequence ?? 0).toLocaleString()}`,
      `Catch-up barrier: hard 30,000 ms cap; waits ${metrics.catchUpWaits ?? 0}, active ${metrics.activeCatchUpWaits ?? 0}, timeouts ${metrics.catchUpTimeouts ?? 0}, failures ${metrics.catchUpFailures ?? 0}, cancellations ${metrics.catchUpCancellations ?? 0}`,
      `Child resets/reprimes: ${metrics.childResets ?? 0}`,
      `Active Advisor tools: ${formatList(metrics.activeToolNames)}`,
      `Advisor guidance: ${formatList(metrics.guidancePaths)}`,
      `Latest review duration: ${metrics.latestDurationMs === undefined ? "not available" : `${Math.round(metrics.latestDurationMs).toLocaleString()} ms`}`,
      `Advisor tokens: input ${(metrics.inputTokens ?? 0).toLocaleString()}, output ${(metrics.outputTokens ?? 0).toLocaleString()}, cache read ${(metrics.cacheReadTokens ?? 0).toLocaleString()}, cache write ${(metrics.cacheWriteTokens ?? 0).toLocaleString()}, total ${(metrics.totalTokens ?? 0).toLocaleString()}`,
      `Advisor cost: $${(metrics.cost ?? 0).toFixed(6)}`,
      `Last advisor action: ${metrics.lastAction ?? "none"}`,
      `Last failure class: ${metrics.lastFailureKind ?? "none"}`,
      `Suppressed duplicate findings: ${metrics.suppressedFindings ?? 0}`,
      `Skipped reviews: ${formatSkippedReviews(metrics.skippedReviews ?? {})}`,
      `Timeout: ${config.timeoutMs.toLocaleString()} ms`,
      `Context cap: ${config.maxContextChars.toLocaleString()} characters`,
      `Session review attempts: ${metrics.attempted}`,
      `Session reviews: settled ${settled}, in progress ${inProgress}`,
      `Session review results: pass ${metrics.pass}, revise ${metrics.revise}, discarded ${metrics.discarded} · suggest ${metrics.suggest ?? 0}`,
      `Operational failures: ${metrics.failure}`,
      `Failure log: ${getAdvisorFailureLogPath(config.configPath)}`,
      `Settings file: ${config.configPath}`,
    );
  }

  ctx.ui.notify(lines.join("\n"), config.enabled && (!model || !credentials) ? "warning" : "info");
}

export function isVerbose(args: string): boolean {
  const normalized = args.trim().toLowerCase();
  return normalized === "--verbose" || normalized === "-v" || normalized === "verbose";
}

export { CONTEXT_OPTIONS, POLICY_OPTIONS, THINKING_LEVELS, TIMEOUT_OPTIONS };
