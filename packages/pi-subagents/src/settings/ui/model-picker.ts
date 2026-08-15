import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem } from "@earendil-works/pi-tui";
import type { NativeRuntimeModel } from "../../boundary/native-model-catalog.ts";
import type { ProfileId } from "../../profiles/model.ts";
import { SUBAGENT_FAST_SERVICE_TIER, supportsSubagentFastMode } from "../../run/fast-mode.ts";
import type { SubagentEffort, SubagentHost, SubagentRuntime } from "../../domain/routing.ts";
import { isSafeNativeModelSelector } from "../../run/native-model-selector.ts";
import { SearchableSelectPage, type SettingsSelectKeybindingId } from "./searchable-select-page.ts";

export type ProfileModelChoice =
  | { readonly kind: "model"; readonly selector: string }
  | { readonly kind: "parent" };

export interface ProfileModelPickerChoice {
  readonly choice: ProfileModelChoice;
  readonly item: SelectItem;
  readonly searchText: string;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable: boolean;
}

const choiceValue = (choice: ProfileModelChoice): string =>
  choice.kind === "model" ? choice.selector : "parent";

const boundedMiddle = (value: string, maximum: number): string => {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  return `${characters.slice(0, left).join("")}…${characters.slice(characters.length - (maximum - left - 1)).join("")}`;
};

/** Authenticated canonical Pi models, plus local Pi's special parent selector. */
export function createProfileModelChoices(input: {
  readonly models: readonly Model<Api>[];
  readonly parentModel?: Model<Api> | undefined;
  readonly currentSelector?: string | undefined;
  readonly allowParent: boolean;
}): ProfileModelPickerChoice[] {
  const result: ProfileModelPickerChoice[] = [];
  if (input.allowParent) {
    const canonical = input.parentModel
      ? `${input.parentModel.provider}/${input.parentModel.id}`
      : undefined;
    const efforts = input.parentModel
      ? (getSupportedThinkingLevels(input.parentModel) as ReadonlyArray<SubagentEffort>)
      : undefined;
    result.push({
      choice: { kind: "parent" },
      item: {
        value: "parent",
        label: `Parent model${input.currentSelector === "parent" ? " (current)" : ""}`,
        description: canonical
          ? `${boundedMiddle(canonical, 72)} · ${input.parentModel?.reasoning ? "reasoning" : "no reasoning"} · efforts: ${efforts?.join(", ") || "none"}`
          : "Uses the active parent model at launch",
      },
      searchText: `parent ${canonical ?? "active model"} ${input.parentModel?.name ?? ""}`,
      ...(efforts === undefined ? {} : { supportedEfforts: efforts }),
      fastModeAvailable: input.parentModel
        ? supportsSubagentFastMode("pi", `${input.parentModel.provider}/${input.parentModel.id}`)
        : false,
    });
  }
  for (const model of input.models) {
    const canonical = `${model.provider}/${model.id}`;
    if (!isSafeNativeModelSelector(canonical)) continue;
    const efforts = getSupportedThinkingLevels(model) as ReadonlyArray<SubagentEffort>;
    result.push({
      choice: { kind: "model", selector: canonical },
      item: {
        value: canonical,
        label: `${boundedMiddle(canonical, 88)}${input.currentSelector === canonical ? " (current)" : ""}`,
        description: `${model.name && model.name !== model.id ? `${boundedMiddle(model.name, 48)} · ` : ""}${model.reasoning ? "reasoning" : "no reasoning"} · efforts: ${efforts.join(", ") || "none"}${supportsSubagentFastMode("pi", canonical) ? " · fast mode available" : ""}`,
      },
      searchText: `${canonical} ${model.name ?? ""}`,
      supportedEfforts: efforts,
      fastModeAvailable: supportsSubagentFastMode("pi", canonical),
    });
  }
  return result;
}

export const createNativeModelChoices = (
  models: ReadonlyArray<NativeRuntimeModel>,
  currentSelector: string,
): ProfileModelPickerChoice[] =>
  models
    .filter((model) => isSafeNativeModelSelector(model.selector))
    .map((model) => ({
      choice: { kind: "model", selector: model.selector },
      item: {
        value: model.selector,
        label: `${boundedMiddle(model.label || model.selector, 72)}${model.isDefault ? " (default)" : ""}${model.selector === currentSelector ? " (current)" : ""}`,
        description: `${boundedMiddle(model.selector, 72)}${model.description ? ` · ${boundedMiddle(model.description, 96)}` : ""} · efforts: ${model.supportedEfforts.join(", ") || "runtime default"}${model.supportedServiceTiers.includes(SUBAGENT_FAST_SERVICE_TIER) ? " · fast mode available" : ""}`,
      },
      searchText: `${model.selector} ${model.label} ${model.description}`,
      supportedEfforts: model.supportedEfforts,
      fastModeAvailable: model.supportedServiceTiers.includes(SUBAGENT_FAST_SERVICE_TIER),
    }));

export interface ProfileModelPickerContext {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
}

export interface ProfileModelPickerPageOptions {
  readonly theme: Theme;
  readonly choices: ReadonlyArray<ProfileModelPickerChoice>;
  readonly current?: string | undefined;
  readonly context: ProfileModelPickerContext;
  readonly notice?: string | undefined;
  readonly getHeight: () => number;
  readonly requestRender: () => void;
  readonly matchesKeybinding?:
    | ((data: string, id: SettingsSelectKeybindingId) => boolean)
    | undefined;
  readonly keybindingLabel?:
    | ((id: SettingsSelectKeybindingId, fallback: string) => string)
    | undefined;
  readonly select: (choice: ProfileModelChoice) => void;
  readonly cancel: () => void;
}

const runtimeLabel = (runtime: SubagentRuntime): string =>
  runtime === "pi" ? "Pi" : runtime === "claude" ? "Claude Code" : "Codex";

/** Full-page searchable model dropdown used inside the profile workspace. */
export class ProfileModelPickerPage implements Component {
  private readonly page: SearchableSelectPage<ProfileModelChoice>;

  constructor(options: ProfileModelPickerPageOptions) {
    const context = options.context;
    const host = context.host === "local" ? "Local" : "Herdr";
    const source =
      context.runtime === "pi"
        ? `authenticated canonical models${context.host === "local" ? " · parent allowed" : ""}`
        : "native advertised models";
    this.page = new SearchableSelectPage({
      theme: options.theme,
      breadcrumb: `/subagents profiles › ${context.profile} › candidate ${context.candidateIndex + 1} › Model`,
      title: `Choose model · ${context.profile} · candidate ${context.candidateIndex + 1}`,
      subtitle: `${host} ${runtimeLabel(context.runtime)} · ${source}`,
      choices: options.choices.map((choice) => ({
        value: choiceValue(choice.choice),
        item: choice.item,
        searchText: choice.searchText,
        payload: choice.choice,
      })),
      current: options.current,
      ...(options.notice ? { notice: options.notice } : {}),
      emptyText: "No matching models",
      getHeight: options.getHeight,
      requestRender: options.requestRender,
      matchesKeybinding: options.matchesKeybinding,
      keybindingLabel: options.keybindingLabel,
      select: options.select,
      cancel: options.cancel,
    });
  }

  get focused(): boolean {
    return this.page.focused;
  }

  set focused(value: boolean) {
    this.page.focused = value;
  }

  handleInput(data: string): void {
    this.page.handleInput(data);
  }

  render(width: number): string[] {
    return this.page.render(width);
  }

  invalidate(): void {
    this.page.invalidate();
  }
}
