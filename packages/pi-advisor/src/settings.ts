import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { supportsFastModel } from "pi-better-openai/fast-models";
import {
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
  writeAdvisorConfigPatch,
} from "./config.ts";

const SETTINGS_COMMAND = "advisor-settings";
const STATUS_COMMAND = "advisor-status";
const CLEAR_MODEL_OPTION = "Clear advisor model";

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

export interface AdvisorConfigState {
  get(): ResolvedAdvisorConfig;
  getMetrics(): Readonly<AdvisorSessionMetrics>;
  update(config: ResolvedAdvisorConfig): void;
}

export interface AdvisorSessionMetrics {
  attempted: number;
  pass: number;
  revise: number;
  failure: number;
  discarded: number;
  backgroundState?: "idle" | "queued" | "reviewing";
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cooldownRemaining?: number;
  cost?: number;
  guidancePaths?: readonly string[];
  inputTokens?: number;
  lastAction?: "advice" | "discarded" | "failure" | "pass" | "revision" | "suppressed";
  latestDurationMs?: number;
  outputTokens?: number;
  queuedReviews?: number;
  suppressedFindings?: number;
  totalTokens?: number;
}

export function registerAdvisorCommands(pi: ExtensionAPI, state: AdvisorConfigState): void {
  pi.registerCommand(SETTINGS_COMMAND, {
    description: "Configure automatic advisor review",
    handler: async (_args, ctx) => openAdvisorSettings(ctx, state),
  });
  pi.registerCommand(STATUS_COMMAND, {
    description: "Show advisor model and configuration status",
    handler: async (_args, ctx) => showAdvisorStatus(ctx, state.get(), state.getMetrics()),
  });
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
    const config = state.get();
    const enabledOption = `Automatic review: ${config.enabled ? "on" : "off"}`;
    const modelOption = `Advisor model: ${formatModel(config)}`;
    const fastModeOption = supportsFastModel(config.provider, config.model)
      ? `OpenAI fast mode: ${config.fastMode ? "on" : "off"}`
      : undefined;
    const thinkingOption = `Reasoning level: ${config.thinkingLevel}`;
    const cooldownOption = `Revision cooldown: ${formatTurnCount(config.revisionCooldownTurns)}`;
    const timeoutOption = `Review timeout: ${formatDuration(config.timeoutMs)}`;
    const contextOption = `Context cap: ${config.maxContextChars.toLocaleString()} characters`;
    const doneOption = "Done";
    const choice = await ctx.ui.select(
      "Advisor settings",
      [
        enabledOption,
        modelOption,
        fastModeOption,
        thinkingOption,
        cooldownOption,
        timeoutOption,
        contextOption,
        doneOption,
      ].filter((option): option is string => option !== undefined),
    );

    if (!choice || choice === doneOption) return;
    if (choice === enabledOption) {
      savePatch(ctx, state, { enabled: !config.enabled });
    } else if (choice === modelOption) {
      await chooseAdvisorModel(ctx, state);
    } else if (fastModeOption && choice === fastModeOption) {
      savePatch(ctx, state, { fastMode: !config.fastMode });
    } else if (choice === thinkingOption) {
      await chooseThinkingLevel(ctx, state);
    } else if (choice === cooldownOption) {
      await chooseNumericSetting(
        ctx,
        "Advisor revision cooldown",
        COOLDOWN_OPTIONS.map((value) => ({ label: formatTurnCount(value), value })),
        (revisionCooldownTurns) => savePatch(ctx, state, { revisionCooldownTurns }),
      );
    } else if (choice === timeoutOption) {
      await chooseNumericSetting(
        ctx,
        "Advisor review timeout",
        TIMEOUT_OPTIONS.map((value) => ({ label: formatDuration(value), value })),
        (timeoutMs) => savePatch(ctx, state, { timeoutMs }),
      );
    } else if (choice === contextOption) {
      await chooseNumericSetting(
        ctx,
        "Advisor context cap",
        CONTEXT_OPTIONS.map((value) => ({
          label: `${value.toLocaleString()} characters`,
          value,
        })),
        (maxContextChars) => savePatch(ctx, state, { maxContextChars }),
      );
    }
  }
}

async function chooseAdvisorModel(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
): Promise<void> {
  const models = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({ label: `${model.provider}/${model.id}`, model }))
    .sort((left, right) => left.label.localeCompare(right.label));
  if (models.length === 0) {
    if (state.get().configured) {
      const selection = await ctx.ui.select("Dedicated advisor model", [CLEAR_MODEL_OPTION]);
      if (selection === CLEAR_MODEL_OPTION) {
        savePatch(ctx, state, { provider: undefined, model: undefined });
      }
      return;
    }
    ctx.ui.notify(
      "No authenticated models are available. Configure a provider in pi first.",
      "warning",
    );
    return;
  }

  const selection = await selectAdvisorModel(
    ctx,
    models.map(({ model }) => model),
    state.get(),
  );
  if (!selection) return;
  if (selection === CLEAR_MODEL_OPTION) {
    savePatch(ctx, state, { provider: undefined, model: undefined });
    return;
  }

  const selected = models.find(({ label }) => label === selection)?.model;
  if (!selected) return;
  savePatch(ctx, state, {
    provider: selected.provider,
    model: selected.id,
    thinkingLevel: clampThinkingLevel(selected, state.get().thinkingLevel),
  });
}

async function selectAdvisorModel(
  ctx: ExtensionCommandContext,
  models: readonly Model<Api>[],
  config: Pick<ResolvedAdvisorConfig, "provider" | "model">,
): Promise<string | undefined> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    return await ctx.ui.select("Dedicated advisor model", [
      ...models.map((model) => `${model.provider}/${model.id}`),
      CLEAR_MODEL_OPTION,
    ]);
  }

  const currentValue =
    config.provider && config.model ? `${config.provider}/${config.model}` : undefined;
  const choices: Array<{ item: SelectItem; searchText: string }> = models.map((model) => {
    const value = `${model.provider}/${model.id}`;
    const levels = getSupportedThinkingLevels(model).join(", ");
    const name = model.name && model.name !== model.id ? model.name : undefined;
    return {
      item: {
        value,
        label: value === currentValue ? `${value} (current)` : value,
        description: `${name ? `${name} · ` : ""}reasoning: ${levels}${supportsFastModel(model.provider, model.id) ? " · fast mode available" : ""}`,
      } satisfies SelectItem,
      searchText: `${value} ${model.name ?? ""}`,
    };
  });
  choices.push({
    item: { value: CLEAR_MODEL_OPTION, label: CLEAR_MODEL_OPTION },
    searchText: CLEAR_MODEL_OPTION,
  });

  return (
    (await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
      const input = new Input();
      const topBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
      const bottomBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
      let title: Text;
      let searchLabel: Text;
      let hint: Text;
      const rebuildThemedText = () => {
        title = new Text(theme.fg("accent", theme.bold("Select Advisor Model")), 1, 0);
        searchLabel = new Text(theme.fg("dim", "Search models:"), 1, 0);
        hint = new Text(
          theme.fg("dim", "Type to search · ↑↓ navigate · enter select · esc cancel"),
          1,
          0,
        );
      };
      rebuildThemedText();
      const listTheme = {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (_text: string) => theme.fg("warning", "  No matching models"),
      };
      let query = "";
      let selectList = buildModelSelectList(choices, query, currentValue, listTheme, done);

      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render(width: number) {
          return [
            ...topBorder.render(width),
            ...title.render(width),
            ...searchLabel.render(width),
            ...input.render(width),
            "",
            ...selectList.render(width),
            "",
            ...hint.render(width),
            ...bottomBorder.render(width),
          ];
        },
        invalidate() {
          topBorder.invalidate();
          bottomBorder.invalidate();
          input.invalidate();
          selectList.invalidate();
          rebuildThemedText();
        },
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.up") ||
            keybindings.matches(data, "tui.select.down") ||
            keybindings.matches(data, "tui.select.confirm") ||
            keybindings.matches(data, "tui.select.cancel")
          ) {
            selectList.handleInput(data);
          } else {
            input.handleInput(data);
            const nextQuery = input.getValue();
            if (nextQuery !== query) {
              query = nextQuery;
              selectList = buildModelSelectList(choices, query, currentValue, listTheme, done);
            }
          }
          tui.requestRender();
        },
      };
    })) ?? undefined
  );
}

function buildModelSelectList(
  choices: Array<{ item: SelectItem; searchText: string }>,
  query: string,
  currentValue: string | undefined,
  theme: ConstructorParameters<typeof SelectList>[2],
  done: (value: string | null) => void,
): SelectList {
  const filtered = fuzzyFilter(choices, query, (choice) => choice.searchText);
  const selectList = new SelectList(
    filtered.map((choice) => choice.item),
    10,
    theme,
  );
  if (!query && currentValue) {
    const currentIndex = filtered.findIndex((choice) => choice.item.value === currentValue);
    if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
  }
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(null);
  return selectList;
}

async function chooseThinkingLevel(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
): Promise<void> {
  const config = state.get();
  const model =
    config.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : undefined;
  const levels = model ? getSupportedThinkingLevels(model) : THINKING_LEVELS;
  const selection = await ctx.ui.select("Advisor reasoning level", [...levels]);
  if (selection && THINKING_LEVELS.includes(selection as ModelThinkingLevel)) {
    savePatch(ctx, state, { thinkingLevel: selection as ModelThinkingLevel });
  }
}

async function chooseNumericSetting(
  ctx: ExtensionCommandContext,
  title: string,
  options: Array<{ label: string; value: number }>,
  save: (value: number) => void,
): Promise<void> {
  const selected = await ctx.ui.select(
    title,
    options.map(({ label }) => label),
  );
  const value = options.find(({ label }) => label === selected)?.value;
  if (value !== undefined) save(value);
}

function savePatch(
  ctx: ExtensionCommandContext,
  state: AdvisorConfigState,
  patch: AdvisorConfigPatch,
): void {
  try {
    state.update(writeAdvisorConfigPatch(patch, state.get().configPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not save advisor settings: ${message}`, "error");
  }
}

async function showAdvisorStatus(
  ctx: ExtensionCommandContext,
  config: ResolvedAdvisorConfig,
  metrics: Readonly<AdvisorSessionMetrics>,
): Promise<void> {
  const model =
    config.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : undefined;
  const credentials = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
  const completed = metrics.pass + metrics.revise + metrics.failure + metrics.discarded;
  const inProgress = Math.max(0, metrics.attempted - completed);
  const lines = [
    `Automatic review: ${config.enabled ? "enabled" : "disabled"}`,
    `Configuration: ${config.configured ? "configured" : "model required"}`,
    `Advisor model: ${formatModel(config)}`,
    `Model available: ${model ? "yes" : "no"}`,
    `Credentials configured: ${credentials ? "yes" : "no"}`,
    `Reasoning level: ${config.thinkingLevel}`,
    `Effective reasoning level: ${model ? clampThinkingLevel(model, config.thinkingLevel) : "unknown"}`,
    `OpenAI fast mode: ${formatFastMode(config)}`,
    `Revision cooldown: ${formatTurnCount(config.revisionCooldownTurns)} configured, ${metrics.cooldownRemaining ?? 0} remaining`,
    `Background state: ${metrics.backgroundState ?? "idle"} (${metrics.queuedReviews ?? 0} queued)`,
    `Advisor guidance: ${formatGuidancePaths(metrics.guidancePaths)}`,
    `Latest review duration: ${metrics.latestDurationMs === undefined ? "not available" : `${Math.round(metrics.latestDurationMs).toLocaleString()} ms`}`,
    `Advisor tokens: input ${(metrics.inputTokens ?? 0).toLocaleString()}, output ${(metrics.outputTokens ?? 0).toLocaleString()}, cache read ${(metrics.cacheReadTokens ?? 0).toLocaleString()}, cache write ${(metrics.cacheWriteTokens ?? 0).toLocaleString()}, total ${(metrics.totalTokens ?? 0).toLocaleString()}`,
    `Advisor cost: $${(metrics.cost ?? 0).toFixed(6)}`,
    `Last advisor action: ${metrics.lastAction ?? "none"}`,
    `Suppressed duplicate findings: ${metrics.suppressedFindings ?? 0}`,
    `Timeout: ${config.timeoutMs.toLocaleString()} ms`,
    `Context cap: ${config.maxContextChars.toLocaleString()} characters`,
    `Session review attempts: ${metrics.attempted}`,
    `Session review outcomes: pass ${metrics.pass}, revise ${metrics.revise}, failure ${metrics.failure}, discarded ${metrics.discarded}, in progress ${inProgress}`,
    `Settings file: ${config.configPath}`,
  ];
  ctx.ui.notify(lines.join("\n"), config.enabled && (!model || !credentials) ? "warning" : "info");
}

function formatDuration(milliseconds: number): string {
  return `${milliseconds / 1_000}s`;
}

function formatTurnCount(turns: number): string {
  return `${turns} ${turns === 1 ? "turn" : "turns"}`;
}

function formatGuidancePaths(paths: readonly string[] | undefined): string {
  return paths && paths.length > 0 ? paths.join(", ") : "none";
}

function formatModel(config: Pick<ResolvedAdvisorConfig, "provider" | "model">): string {
  return config.provider && config.model ? `${config.provider}/${config.model}` : "not configured";
}

function formatFastMode(
  config: Pick<ResolvedAdvisorConfig, "fastMode" | "provider" | "model">,
): string {
  if (!config.fastMode) return "disabled";
  return supportsFastModel(config.provider, config.model)
    ? "enabled (active)"
    : "enabled (inactive for unsupported model)";
}

export const _settingsTest = {
  CLEAR_MODEL_OPTION,
  CONTEXT_OPTIONS,
  COOLDOWN_OPTIONS,
  THINKING_LEVELS,
  TIMEOUT_OPTIONS,
  formatDuration,
  formatFastMode,
  formatModel,
};
