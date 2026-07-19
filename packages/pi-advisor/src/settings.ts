import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { supportsFastModel } from "pi-better-openai/fast-models";
import { safeAdvisorLabel } from "./advisor-label.ts";
import {
  MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST,
  type AdvisorInterventionBudgetSnapshot,
} from "./intervention-budget.ts";
import { CLEAR_MODEL_OPTION, selectAdvisorModel } from "./model-picker.ts";
import { getAdvisorFailureLogPath } from "./failure-log.ts";
import {
  type AdvisorConfigPatch,
  type AdvisorReviewPolicy,
  type ResolvedAdvisorConfig,
  writeAdvisorConfigPatch,
} from "./config.ts";
import type { AdvisorReviewFocus } from "./review.ts";

const SETTINGS_COMMAND = "advisor-settings";
const STATUS_COMMAND = "advisor-status";
const USAGE_COMMAND = "advisor-usage";
const ADVISOR_COMMAND = "advisor";

const TIMEOUT_OPTIONS = [10_000, 30_000, 60_000, 90_000, 120_000, 180_000] as const;
const CONTEXT_OPTIONS = [16_000, 48_000, 120_000, 240_000] as const;
const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const POLICY_OPTIONS: Array<{ label: string; value: AdvisorReviewPolicy }> = [
  { label: "Corrective (recommended)", value: "corrective" },
  { label: "Guardrail", value: "guardrail" },
  { label: "Advisory", value: "advisory" },
];

export interface AdvisorConfigState {
  get(): ResolvedAdvisorConfig;
  getMetrics(): Readonly<AdvisorSessionMetrics>;
  update(config: ResolvedAdvisorConfig): void;
}

export type AdvisorReviewRequestResult = "started" | "unavailable" | "cancelled";

export interface AdvisorCommandActions {
  cancel(ctx: ExtensionCommandContext): boolean;
  pause(ctx: ExtensionCommandContext): void;
  resume(ctx: ExtensionCommandContext): void;
  reviewLast(
    ctx: ExtensionCommandContext,
    focus: AdvisorReviewFocus,
  ): AdvisorReviewRequestResult | Promise<AdvisorReviewRequestResult>;
  reviewNext(ctx: ExtensionCommandContext): void;
}

export interface AdvisorModelUsage {
  provider: string;
  model: string;
  responses: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AdvisorOutcomeMetrics {
  pass: number;
  findings: number;
  advice: number;
  guidance: number;
  revision: number;
  recovery: number;
  suppressed: number;
  discarded: number;
  failures: number;
}

export function emptyAdvisorOutcomes(): AdvisorOutcomeMetrics {
  return {
    pass: 0,
    findings: 0,
    advice: 0,
    guidance: 0,
    revision: 0,
    recovery: 0,
    suppressed: 0,
    discarded: 0,
    failures: 0,
  };
}

export interface AdvisorSessionMetrics {
  attempted: number;
  pass: number;
  revise: number;
  failure: number;
  discarded: number;
  skippedReviews?: Record<string, number>;
  backgroundState?: "idle" | "queued" | "reviewing" | "revision-pending";
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  activeCatchUpWaits?: number;
  activeToolNames?: readonly string[];
  backlog?: number;
  catchUpCancellations?: number;
  catchUpFailures?: number;
  catchUpTimeouts?: number;
  catchUpWaits?: number;
  childResets?: number;
  cost?: number;
  guidancePaths?: readonly string[];
  hasLastCandidate?: boolean;
  inputTokens?: number;
  lastAction?:
    | "advice"
    | "discarded"
    | "failure"
    | "guidance"
    | "pass"
    | "recovery"
    | "revision"
    | "suppressed";
  lastFailureKind?: string;
  latestDurationMs?: number;
  modelResponses?: number;
  outputTokens?: number;
  outcomes: AdvisorOutcomeMetrics;
  blockerVerificationAttempts?: number;
  blockersVerified?: number;
  blockersRejected?: number;
  interventionsDelivered?: number;
  interventionsAcknowledged?: number;
  findingLifecycle?: Record<"open" | "acknowledged" | "resolved" | "superseded", number>;
  interventionBudget?: AdvisorInterventionBudgetSnapshot;
  paused?: boolean;
  processedSequence?: number;
  queuedReviews?: number;
  reviewNext?: boolean;
  sequence?: number;
  suppressedFindings?: number;
  settledReviews?: number;
  totalDurationMs?: number;
  totalTokens?: number;
  usageByModel?: Record<string, AdvisorModelUsage>;
}

export function registerAdvisorCommands(
  pi: ExtensionAPI,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions = NOOP_COMMAND_ACTIONS,
): void {
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
    handler: async (args, ctx) => handleAdvisorCommand(args, ctx, state, actions),
  });
  pi.registerCommand(SETTINGS_COMMAND, {
    description: "Configure automatic advisor supervision",
    handler: async (_args, ctx) => openAdvisorSettings(ctx, state),
  });
  pi.registerCommand(STATUS_COMMAND, {
    description: "Show advisor model and configuration status",
    handler: async (args, ctx) =>
      showAdvisorStatus(ctx, state.get(), state.getMetrics(), isVerbose(args)),
  });
  pi.registerCommand(USAGE_COMMAND, {
    description: "Show advisor usage for this session",
    handler: async (_args, ctx) => showAdvisorUsage(ctx, state.get(), state.getMetrics()),
  });
}

async function handleAdvisorCommand(
  args: string,
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions,
): Promise<void> {
  const command = args.trim().toLowerCase();
  if (!command) {
    await openAdvisorDashboard(ctx, state, actions);
    return;
  }

  if (command === "once") {
    actions.reviewNext(ctx);
    ctx.ui.notify("Advisor will review the next completed response.", "info");
    return;
  }
  if (command === "review-last" || command === "verify-last") {
    const focus = command === "verify-last" ? "verification" : "standard";
    const result = await actions.reviewLast(ctx, focus);
    if (result === "unavailable") {
      ctx.ui.notify("No completed response is available to review.", "warning");
    } else if (result === "started") {
      ctx.ui.notify(
        focus === "verification"
          ? "Started an evidence-focused transcript review of the last response."
          : "Started a review of the last response.",
        "info",
      );
    }
    return;
  }
  if (command === "pause") {
    actions.pause(ctx);
    ctx.ui.notify("Advisor paused for this session.", "info");
    return;
  }
  if (command === "resume") {
    actions.resume(ctx);
    ctx.ui.notify("Advisor resumed for this session.", "info");
    return;
  }
  if (command === "cancel") {
    ctx.ui.notify(
      actions.cancel(ctx) ? "Cancelled pending advisor work." : "No advisor review is active.",
      "info",
    );
    return;
  }
  if (command === "on" || command === "off") {
    const enabled = command === "on";
    if (updateConfig(ctx, state, { enabled })) {
      ctx.ui.notify(`Automatic advisor review ${enabled ? "enabled" : "disabled"}.`, "info");
    }
    return;
  }
  if (command === "settings") {
    await openAdvisorSettings(ctx, state);
    return;
  }
  if (command === "status" || command === "status --verbose" || command === "status -v") {
    await showAdvisorStatus(ctx, state.get(), state.getMetrics(), command !== "status");
    return;
  }

  ctx.ui.notify(
    "Usage: /advisor [once|review-last|verify-last|pause|resume|cancel|on|off|settings|status [--verbose]]",
    "error",
  );
}

async function openAdvisorDashboard(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  actions: AdvisorCommandActions,
): Promise<void> {
  if (!ctx.hasUI) {
    await showAdvisorStatus(ctx, state.get(), state.getMetrics(), false);
    return;
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
  const choice = await ctx.ui.select(
    `Advisor · ${formatPolicy(config.reviewPolicy)} · persistent read-only · ${formatModel(config)}`,
    choices,
  );

  if (choice === "Review next response") {
    actions.reviewNext(ctx);
    ctx.ui.notify("Advisor will review the next completed response.", "info");
  } else if (choice === "Review last response" || choice === "Verify last response") {
    const focus = choice === "Verify last response" ? "verification" : "standard";
    if (await actions.reviewLast(ctx, focus)) {
      ctx.ui.notify(
        focus === "verification"
          ? "Started an evidence-focused transcript review."
          : "Started review.",
        "info",
      );
    }
  } else if (choice === pauseOption) {
    if (metrics.paused) actions.resume(ctx);
    else actions.pause(ctx);
  } else if (choice === enableOption) {
    updateConfig(ctx, state, { enabled: !config.enabled });
  } else if (choice === "Settings") {
    await openAdvisorSettings(ctx, state);
  } else if (choice === "Status") {
    await showAdvisorStatus(ctx, state.get(), state.getMetrics(), false);
  }
}

async function openAdvisorSettings(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/advisor-settings requires interactive UI.", "error");
    return;
  }

  while (true) {
    const current = state.get();
    const enabledOption = `Advisor supervision: ${current.enabled ? "on" : "off"}`;
    const policyOption = `Behavior: ${formatPolicy(current.reviewPolicy)}`;
    const modelOption = `Advisor model: ${formatModel(current)}`;
    const fastModeOption = `OpenAI fast mode: ${current.fastMode ? "on" : "off"}`;
    const thinkingOption = `Reasoning level: ${current.thinkingLevel}`;
    const timeoutOption = `Advisor operation timeout: ${formatDuration(current.timeoutMs)}`;
    const contextOption = `Context cap: ${current.maxContextChars.toLocaleString()} characters`;
    const choice = await ctx.ui.select("Advisor settings · changes apply immediately", [
      enabledOption,
      policyOption,
      modelOption,
      fastModeOption,
      thinkingOption,
      timeoutOption,
      contextOption,
      "Done",
    ]);

    if (!choice || choice === "Done") return;
    if (choice === enabledOption) {
      updateConfig(ctx, state, { enabled: !current.enabled });
    } else if (choice === policyOption) {
      const next = await choosePolicy(ctx, current.reviewPolicy);
      if (next && next !== current.reviewPolicy) updateConfig(ctx, state, { reviewPolicy: next });
    } else if (choice === modelOption) {
      const next = await chooseAdvisorModel(ctx, current);
      if (
        next.provider !== current.provider ||
        next.model !== current.model ||
        next.thinkingLevel !== current.thinkingLevel
      ) {
        updateConfig(ctx, state, {
          provider: next.provider,
          model: next.model,
          thinkingLevel: next.thinkingLevel,
        });
      }
    } else if (choice === fastModeOption) {
      updateConfig(ctx, state, { fastMode: !current.fastMode });
    } else if (choice === thinkingOption) {
      const thinkingLevel = await chooseThinkingLevel(ctx, current);
      if (thinkingLevel && thinkingLevel !== current.thinkingLevel) {
        updateConfig(ctx, state, { thinkingLevel });
      }
    } else if (choice === timeoutOption) {
      const timeoutMs = await chooseNumericSetting(
        ctx,
        "Advisor operation timeout",
        TIMEOUT_OPTIONS.map((item) => ({ label: formatDuration(item), value: item })),
      );
      if (timeoutMs !== undefined && timeoutMs !== current.timeoutMs) {
        updateConfig(ctx, state, { timeoutMs });
      }
    } else if (choice === contextOption) {
      const maxContextChars = await chooseNumericSetting(
        ctx,
        "Advisor context cap",
        CONTEXT_OPTIONS.map((item) => ({
          label: `${item.toLocaleString()} characters`,
          value: item,
        })),
      );
      if (maxContextChars !== undefined && maxContextChars !== current.maxContextChars) {
        updateConfig(ctx, state, { maxContextChars });
      }
    }
  }
}

async function choosePolicy(
  ctx: ExtensionCommandContext,
  current: AdvisorReviewPolicy,
): Promise<AdvisorReviewPolicy | undefined> {
  const labels = POLICY_OPTIONS.map(({ label, value }) =>
    value === current ? `${label} (current)` : label,
  );
  const selected = await ctx.ui.select("Advisor behavior", labels);
  const normalized = selected?.replace(" (current)", "");
  return POLICY_OPTIONS.find(({ label }) => label === normalized)?.value;
}

async function chooseAdvisorModel(
  ctx: ExtensionCommandContext,
  draft: ResolvedAdvisorConfig,
): Promise<ResolvedAdvisorConfig> {
  const models = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({ label: `${model.provider}/${model.id}`, model }))
    .sort((left, right) => left.label.localeCompare(right.label));
  if (models.length === 0) {
    if (draft.configured) {
      const selection = await ctx.ui.select("Dedicated advisor model", [CLEAR_MODEL_OPTION]);
      if (selection === CLEAR_MODEL_OPTION) {
        return { ...draft, provider: undefined, model: undefined, configured: false };
      }
      return draft;
    }
    ctx.ui.notify(
      "No authenticated models are available. Configure a provider in pi first.",
      "warning",
    );
    return draft;
  }

  const selection = await selectAdvisorModel(
    ctx,
    models.map(({ model }) => model),
    draft,
  );
  if (!selection) return draft;
  if (selection === CLEAR_MODEL_OPTION) {
    return { ...draft, provider: undefined, model: undefined, configured: false };
  }

  const selected = models.find(({ label }) => label === selection)?.model;
  if (!selected) return draft;
  return {
    ...draft,
    provider: selected.provider,
    model: selected.id,
    configured: true,
    thinkingLevel: clampThinkingLevel(selected, draft.thinkingLevel),
  };
}

async function chooseThinkingLevel(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
): Promise<ModelThinkingLevel | undefined> {
  const model =
    config.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : undefined;
  const levels = model ? getSupportedThinkingLevels(model) : THINKING_LEVELS;
  const selection = await ctx.ui.select("Advisor reasoning level", [...levels]);
  return selection && THINKING_LEVELS.includes(selection as ModelThinkingLevel)
    ? (selection as ModelThinkingLevel)
    : undefined;
}

async function chooseNumericSetting(
  ctx: ExtensionCommandContext,
  title: string,
  options: Array<{ label: string; value: number }>,
): Promise<number | undefined> {
  const selected = await ctx.ui.select(
    title,
    options.map(({ label }) => label),
  );
  return options.find(({ label }) => label === selected)?.value;
}

function updateConfig(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  patch: AdvisorConfigPatch,
): boolean {
  try {
    state.update(writeAdvisorConfigPatch(patch, state.get().configPath));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not save advisor settings: ${message}`, "error");
    return false;
  }
}

async function showAdvisorUsage(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
  metrics: Readonly<AdvisorSessionMetrics>,
): Promise<void> {
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
  const evaluated = outcomes.pass + outcomes.findings;
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

async function showAdvisorStatus(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
  metrics: Readonly<AdvisorSessionMetrics>,
  verbose: boolean,
): Promise<void> {
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
      `Active Advisor tools: ${formatActiveTools(metrics.activeToolNames)}`,
      `Advisor guidance: ${formatGuidancePaths(metrics.guidancePaths)}`,
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
      `Session review results: pass ${metrics.pass}, revise ${metrics.revise}, discarded ${metrics.discarded}`,
      `Operational failures: ${metrics.failure}`,
      `Failure log: ${getAdvisorFailureLogPath(config.configPath)}`,
      `Settings file: ${config.configPath}`,
    );
  }

  ctx.ui.notify(lines.join("\n"), config.enabled && (!model || !credentials) ? "warning" : "info");
}

function isVerbose(args: string): boolean {
  const normalized = args.trim().toLowerCase();
  return normalized === "--verbose" || normalized === "-v" || normalized === "verbose";
}

function formatLastReview(metrics: Readonly<AdvisorSessionMetrics>): string {
  if (!metrics.lastAction) return "none";
  const duration =
    metrics.latestDurationMs === undefined
      ? ""
      : ` in ${(metrics.latestDurationMs / 1_000).toFixed(1)}s`;
  return `${metrics.lastAction}${duration}`;
}

function formatDuration(milliseconds: number): string {
  return `${milliseconds / 1_000}s`;
}

function formatPercent(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "not available";
}

function formatUsageDuration(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${Math.round(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function formatGuidancePaths(paths: readonly string[] | undefined): string {
  return paths && paths.length > 0 ? paths.join(", ") : "none";
}

function formatActiveTools(names: readonly string[] | undefined): string {
  return names && names.length > 0 ? names.join(", ") : "none";
}

function formatModel(config: Pick<ResolvedAdvisorConfig, "provider" | "model">): string {
  return config.provider && config.model
    ? `${safeAdvisorLabel(config.provider)}/${safeAdvisorLabel(config.model)}`
    : "not configured";
}

function formatPolicy(policy: AdvisorReviewPolicy): string {
  switch (policy) {
    case "corrective":
      return "Corrective";
    case "guardrail":
      return "Guardrail";
    case "advisory":
      return "Advisory";
  }
}

function formatFastMode(
  config: Pick<ResolvedAdvisorConfig, "fastMode" | "provider" | "model">,
): string {
  if (!config.fastMode) return "disabled";
  return supportsFastModel(config.provider, config.model)
    ? "enabled (active)"
    : "enabled (inactive for unsupported model)";
}

const NOOP_COMMAND_ACTIONS: AdvisorCommandActions = {
  cancel: () => false,
  pause: () => {},
  resume: () => {},
  reviewLast: () => "unavailable",
  reviewNext: () => {},
};

function formatSkippedReviews(skipped: Readonly<Record<string, number>>): string {
  const entries = Object.entries(skipped).filter(([, count]) => count > 0);
  return entries.length > 0
    ? entries.map(([reason, count]) => `${reason} ${count}`).join(", ")
    : "none";
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
