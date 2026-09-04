import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { FAST_SERVICE_TIER } from "pi-better-openai/fast-models";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { NativeRuntimeModel } from "../../boundary/native-model-catalog.ts";
import {
  isSafeNativeModelSelector,
  supportsSubagentFastMode,
  type ProfileId,
} from "../../profiles/model.ts";
import type { SubagentEffort, SubagentHost, SubagentRuntime } from "../../domain/routing.ts";
import type { ProjectedPiModel } from "../profile-model-catalog.ts";
import { profileRouteOptionLabel } from "./profile-workspace-model.ts";
import {
  SearchableSelectPage,
  type SearchableSelectHostOptions,
} from "pi-cosmic-ui/manager/searchable-select";

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

const compactSelectItem = (value: string, label: string, description?: string): SelectItem => {
  const base = { value, label };
  return description ? { ...base, description } : base;
};

/** Authenticated canonical Pi models, plus local Pi's special parent selector. */
export function createProfileModelChoices(input: {
  readonly models: ReadonlyArray<ProjectedPiModel>;
  readonly parentModel?: ProjectedPiModel | undefined;
  readonly currentSelector?: string | undefined;
  readonly allowParent: boolean;
}): ProfileModelPickerChoice[] {
  const result: ProfileModelPickerChoice[] = [];
  if (input.allowParent) {
    const canonical = input.parentModel
      ? `${input.parentModel.provider}/${input.parentModel.id}`
      : undefined;
    const efforts = input.parentModel?.supportedEfforts;
    result.push(
      (() => {
        const baseResult = {
          choice: { kind: "parent" as const },
          item: {
            value: "parent",
            label: sanitizeTerminalLine(
              `Current Pi model${canonical ? ` → ${boundedMiddle(sanitizeTerminalLine(canonical), 72)}` : ""}${input.currentSelector === "parent" ? " (current)" : ""}`,
            ),
            description: sanitizeTerminalLine(
              canonical
                ? `${input.parentModel?.name ? `${boundedMiddle(sanitizeTerminalLine(input.parentModel.name), 48)} · ` : ""}current Pi model · ${input.parentModel?.reasoning ? "supports reasoning" : "no reasoning"} · reasoning levels: ${efforts?.join(", ") || "none"}`
                : "Use the current Pi model when this run starts",
            ),
          },
          searchText: sanitizeTerminalLine(
            `parent ${canonical ?? "active model"} ${input.parentModel?.name ?? ""}`,
          ),
        };
        const withSupportedEfforts =
          efforts === undefined ? baseResult : { ...baseResult, supportedEfforts: efforts };
        const withFastModeAvailable = {
          ...withSupportedEfforts,
          fastModeAvailable: input.parentModel
            ? supportsSubagentFastMode(
                "pi",
                `${input.parentModel.provider}/${input.parentModel.id}`,
              )
            : false,
        };
        return withFastModeAvailable;
      })(),
    );
  }
  for (const model of input.models) {
    const canonical = `${model.provider}/${model.id}`;
    if (!isSafeNativeModelSelector(canonical)) continue;
    const efforts = model.supportedEfforts;
    result.push({
      choice: { kind: "model", selector: canonical },
      item: compactSelectItem(
        canonical,
        sanitizeTerminalLine(
          `${boundedMiddle(sanitizeTerminalLine(canonical), 88)}${input.currentSelector === canonical ? " (current)" : ""}`,
        ),
        sanitizeTerminalLine(
          `${model.name && model.name !== model.id ? `${boundedMiddle(sanitizeTerminalLine(model.name), 48)} · ` : ""}${model.reasoning ? "supports reasoning" : "no reasoning"} · reasoning levels: ${efforts.join(", ") || "none"}${supportsSubagentFastMode("pi", canonical) ? " · fast mode available" : ""}`,
        ),
      ),
      searchText: sanitizeTerminalLine(`${canonical} ${model.name ?? ""}`),
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
      item: compactSelectItem(
        model.selector,
        sanitizeTerminalLine(
          `${boundedMiddle(sanitizeTerminalLine(model.selector), 72)}${model.isDefault ? " (default)" : ""}${model.selector === currentSelector ? " (current)" : ""}`,
        ),
        sanitizeTerminalLine(
          `${model.label && model.label !== model.selector ? `${boundedMiddle(sanitizeTerminalLine(model.label), 72)} · ` : ""}${model.description ? `${boundedMiddle(sanitizeTerminalLine(model.description), 96)} · ` : ""}${model.isDefault ? "default model · " : ""}reasoning levels: ${model.supportedEfforts.join(", ") || "default"}${model.supportedServiceTiers.includes(FAST_SERVICE_TIER) ? " · fast mode available" : ""}`,
        ),
      ),
      searchText: sanitizeTerminalLine(
        `${model.selector} ${model.label} ${model.description ?? ""}`,
      ),
      supportedEfforts: model.supportedEfforts,
      fastModeAvailable: model.supportedServiceTiers.includes(FAST_SERVICE_TIER),
    }));

export interface ProfileModelPickerContext {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
}

export interface ProfileModelPickerPageOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly choices: ReadonlyArray<ProfileModelPickerChoice>;
  readonly initialSelection?: string | undefined;
  readonly context: ProfileModelPickerContext;
  readonly targetLabel?: string | undefined;
  readonly notice?: string | undefined;
  readonly select: (choice: ProfileModelChoice) => void;
  readonly cancel: () => void;
}

const runtimeLabel = (runtime: SubagentRuntime): string =>
  runtime === "pi" ? "Pi" : runtime === "claude" ? "Claude" : "Codex";

/** Full-page searchable model dropdown used inside the profile workspace. */
export const makeProfileModelPickerPage = (options: ProfileModelPickerPageOptions) => {
  const context = options.context;
  const host = context.host === "local" ? "Local" : "Herdr";
  const optionLabel = profileRouteOptionLabel(context.candidateIndex);
  const baseResult = {
    theme: options.theme,
    breadcrumb: `/subagents profiles › ${context.profile} › ${optionLabel} › Model`,
    title: `Choose model · ${context.profile} · ${optionLabel}`,
    subtitle: `${options.targetLabel ? `${options.targetLabel} · ` : ""}${host} ${runtimeLabel(context.runtime)}`,
    choices: options.choices.map((choice) => ({
      value: choiceValue(choice.choice),
      item: choice.item,
      searchText: choice.searchText,
      payload: choice.choice,
    })),
    current: options.initialSelection,
  };
  const withNotice = options.notice ? { ...baseResult, notice: options.notice } : baseResult;
  return new SearchableSelectPage<ProfileModelChoice>({
    ...withNotice,
    emptyText: "No matching models",
    getHeight: options.getHeight,
    requestRender: options.requestRender,
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: options.select,
    cancel: options.cancel,
  });
};
