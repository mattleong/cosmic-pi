import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { supportsFastModel } from "pi-better-openai/fast-models";
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
const ADVISOR_COMMAND = "advisor";

const TIMEOUT_OPTIONS = [10_000, 30_000, 60_000, 90_000, 120_000, 180_000] as const;
const CONTEXT_OPTIONS = [16_000, 48_000, 120_000, 240_000] as const;
const COOLDOWN_OPTIONS = [0, 1, 2, 3, 4, 5] as const;
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
  {
    label: "Guardrail (recommended)",
    value: "guardrail",
  },
  { label: "Strict", value: "strict" },
  { label: "Advice only", value: "advice" },
  { label: "Manual", value: "manual" },
];

interface SpeedPreset {
  label: string;
  patch: Pick<ResolvedAdvisorConfig, "thinkingLevel" | "timeoutMs" | "maxContextChars">;
}

const SPEED_PRESETS: readonly SpeedPreset[] = [
  {
    label: "Fast",
    patch: { thinkingLevel: "low", timeoutMs: 30_000, maxContextChars: 16_000 },
  },
  {
    label: "Balanced",
    patch: { thinkingLevel: "medium", timeoutMs: 30_000, maxContextChars: 48_000 },
  },
  {
    label: "Thorough",
    patch: { thinkingLevel: "high", timeoutMs: 90_000, maxContextChars: 120_000 },
  },
];

export interface AdvisorConfigState {
  get(): ResolvedAdvisorConfig;
  getMetrics(): Readonly<AdvisorSessionMetrics>;
  update(config: ResolvedAdvisorConfig): void;
}

export interface AdvisorCommandActions {
  cancel(ctx: ExtensionCommandContext): boolean;
  pause(ctx: ExtensionCommandContext): void;
  resume(ctx: ExtensionCommandContext): void;
  reviewLast(ctx: ExtensionCommandContext, focus: AdvisorReviewFocus): boolean;
  reviewNext(ctx: ExtensionCommandContext): void;
  setEnabled(ctx: ExtensionCommandContext, enabled: boolean): void;
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
  cooldownRemaining?: number;
  cost?: number;
  guidancePaths?: readonly string[];
  hasLastCandidate?: boolean;
  inputTokens?: number;
  lastAction?: "advice" | "discarded" | "failure" | "pass" | "revision" | "suppressed";
  lastFailureKind?: string;
  latestDurationMs?: number;
  outputTokens?: number;
  paused?: boolean;
  queuedReviews?: number;
  reviewNext?: boolean;
  suppressedFindings?: number;
  totalTokens?: number;
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
    description: "Configure automatic advisor review",
    handler: async (_args, ctx) => openAdvisorSettings(ctx, state),
  });
  pi.registerCommand(STATUS_COMMAND, {
    description: "Show advisor model and configuration status",
    handler: async (args, ctx) =>
      showAdvisorStatus(ctx, state.get(), state.getMetrics(), isVerbose(args)),
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
    if (!actions.reviewLast(ctx, focus)) {
      ctx.ui.notify("No completed response is available to review.", "warning");
    } else {
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
      actions.cancel(ctx)
        ? "Cancelled the current advisor review."
        : "No advisor review is active.",
      "info",
    );
    return;
  }
  if (command === "on" || command === "off") {
    const enabled = command === "on";
    if (updateConfig(ctx, state, { enabled })) {
      actions.setEnabled(ctx, enabled);
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
    `Advisor · ${formatPolicy(config.reviewPolicy)} · ${formatModel(config)}`,
    choices,
  );

  if (choice === "Review next response") {
    actions.reviewNext(ctx);
    ctx.ui.notify("Advisor will review the next completed response.", "info");
  } else if (choice === "Review last response" || choice === "Verify last response") {
    const focus = choice === "Verify last response" ? "verification" : "standard";
    if (actions.reviewLast(ctx, focus)) {
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
    const enabled = !config.enabled;
    if (updateConfig(ctx, state, { enabled })) actions.setEnabled(ctx, enabled);
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

  let draft = { ...state.get() };
  while (true) {
    const enabledOption = `Automatic review: ${draft.enabled ? "on" : "off"}`;
    const policyOption = `Behavior: ${formatPolicy(draft.reviewPolicy)}`;
    const modelOption = `Advisor model: ${formatModel(draft)}`;
    const speedOption = `Speed: ${detectSpeedPreset(draft)}`;
    const applyOption = "Apply changes";
    const cancelOption = "Cancel";
    const choice = await ctx.ui.select("Advisor settings", [
      enabledOption,
      policyOption,
      modelOption,
      speedOption,
      "Advanced settings",
      applyOption,
      cancelOption,
    ]);

    if (!choice || choice === cancelOption) return;
    if (choice === applyOption) {
      if (updateConfig(ctx, state, configPatchFromDraft(draft))) {
        ctx.ui.notify(
          `Advisor settings applied · ${formatPolicy(draft.reviewPolicy)} · ${detectSpeedPreset(draft)}`,
          "info",
        );
      }
      return;
    }
    if (choice === enabledOption) {
      draft = { ...draft, enabled: !draft.enabled };
    } else if (choice === policyOption) {
      const next = await choosePolicy(ctx, draft.reviewPolicy);
      if (next) draft = { ...draft, reviewPolicy: next };
    } else if (choice === modelOption) {
      draft = await chooseAdvisorModel(ctx, draft);
    } else if (choice === speedOption) {
      const preset = await chooseSpeedPreset(ctx);
      if (preset) {
        draft = {
          ...draft,
          ...preset.patch,
          thinkingLevel: clampDraftThinkingLevel(ctx, draft, preset.patch.thinkingLevel),
        };
      }
    } else if (choice === "Advanced settings") {
      draft = await openAdvancedSettings(ctx, draft);
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

async function chooseSpeedPreset(ctx: ExtensionCommandContext): Promise<SpeedPreset | undefined> {
  const selected = await ctx.ui.select(
    "Advisor speed",
    SPEED_PRESETS.map(({ label }) => label),
  );
  return SPEED_PRESETS.find(({ label }) => label === selected);
}

async function openAdvancedSettings(
  ctx: ExtensionCommandContext,
  initial: ResolvedAdvisorConfig,
): Promise<ResolvedAdvisorConfig> {
  let draft = initial;
  while (true) {
    const fastModeOption = supportsFastModel(draft.provider, draft.model)
      ? `OpenAI fast mode: ${draft.fastMode ? "on" : "off"}`
      : undefined;
    const thinkingOption = `Reasoning level: ${draft.thinkingLevel}`;
    const cooldownOption = `After a revision, advice-only for ${formatRequestCount(draft.revisionCooldownTurns)}`;
    const timeoutOption = `Review timeout: ${formatDuration(draft.timeoutMs)}`;
    const contextOption = `Context cap: ${draft.maxContextChars.toLocaleString()} characters`;
    const choice = await ctx.ui.select(
      "Advanced advisor settings",
      [fastModeOption, thinkingOption, cooldownOption, timeoutOption, contextOption, "Back"].filter(
        (option): option is string => option !== undefined,
      ),
    );

    if (!choice || choice === "Back") return draft;
    if (fastModeOption && choice === fastModeOption) {
      draft = { ...draft, fastMode: !draft.fastMode };
    } else if (choice === thinkingOption) {
      const thinkingLevel = await chooseThinkingLevel(ctx, draft);
      if (thinkingLevel) draft = { ...draft, thinkingLevel };
    } else if (choice === cooldownOption) {
      const value = await chooseNumericSetting(
        ctx,
        "Advice-only requests after revision",
        COOLDOWN_OPTIONS.map((item) => ({ label: formatRequestCount(item), value: item })),
      );
      if (value !== undefined) draft = { ...draft, revisionCooldownTurns: value };
    } else if (choice === timeoutOption) {
      const value = await chooseNumericSetting(
        ctx,
        "Advisor review timeout",
        TIMEOUT_OPTIONS.map((item) => ({ label: formatDuration(item), value: item })),
      );
      if (value !== undefined) draft = { ...draft, timeoutMs: value };
    } else if (choice === contextOption) {
      const value = await chooseNumericSetting(
        ctx,
        "Advisor context cap",
        CONTEXT_OPTIONS.map((item) => ({
          label: `${item.toLocaleString()} characters`,
          value: item,
        })),
      );
      if (value !== undefined) draft = { ...draft, maxContextChars: value };
    }
  }
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

function clampDraftThinkingLevel(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const model =
    config.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : undefined;
  return model ? clampThinkingLevel(model, level) : level;
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

function configPatchFromDraft(config: ResolvedAdvisorConfig): AdvisorConfigPatch {
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    fastMode: config.fastMode,
    thinkingLevel: config.thinkingLevel,
    reviewPolicy: config.reviewPolicy,
    revisionCooldownTurns: config.revisionCooldownTurns,
    timeoutMs: config.timeoutMs,
    maxContextChars: config.maxContextChars,
  };
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
    `Last review: ${formatLastReview(metrics)}`,
  ];

  if (verbose) {
    const completed = metrics.pass + metrics.revise + metrics.failure + metrics.discarded;
    const inProgress = Math.max(0, metrics.attempted - completed);
    lines.push(
      "",
      `Configuration: ${config.configured ? "configured" : "model required"}`,
      `Reasoning level: ${config.thinkingLevel}`,
      `Effective reasoning level: ${model ? clampThinkingLevel(model, config.thinkingLevel) : "unknown"}`,
      `OpenAI fast mode: ${formatFastMode(config)}`,
      `After-revision advice window: ${formatRequestCount(config.revisionCooldownTurns)} configured, ${metrics.cooldownRemaining ?? 0} remaining`,
      `Background state: ${metrics.backgroundState ?? "idle"} (${metrics.queuedReviews ?? 0} queued)`,
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
      `Session review outcomes: pass ${metrics.pass}, revise ${metrics.revise}, failure ${metrics.failure}, discarded ${metrics.discarded}, in progress ${inProgress}`,
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

function formatRequestCount(requests: number): string {
  return `${requests} ${requests === 1 ? "request" : "requests"}`;
}

function formatGuidancePaths(paths: readonly string[] | undefined): string {
  return paths && paths.length > 0 ? paths.join(", ") : "none";
}

function formatModel(config: Pick<ResolvedAdvisorConfig, "provider" | "model">): string {
  return config.provider && config.model ? `${config.provider}/${config.model}` : "not configured";
}

function formatPolicy(policy: AdvisorReviewPolicy): string {
  switch (policy) {
    case "guardrail":
      return "Guardrail";
    case "strict":
      return "Strict";
    case "advice":
      return "Advice only";
    case "manual":
      return "Manual";
  }
}

function detectSpeedPreset(
  config: Pick<ResolvedAdvisorConfig, "thinkingLevel" | "timeoutMs" | "maxContextChars">,
): string {
  return (
    SPEED_PRESETS.find(
      ({ patch }) =>
        patch.thinkingLevel === config.thinkingLevel &&
        patch.timeoutMs === config.timeoutMs &&
        patch.maxContextChars === config.maxContextChars,
    )?.label ?? "Custom"
  );
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
  reviewLast: () => false,
  reviewNext: () => {},
  setEnabled: () => {},
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
  COOLDOWN_OPTIONS,
  POLICY_OPTIONS,
  SPEED_PRESETS,
  THINKING_LEVELS,
  TIMEOUT_OPTIONS,
  detectSpeedPreset,
  formatDuration,
  formatFastMode,
  formatModel,
  formatPolicy,
};
