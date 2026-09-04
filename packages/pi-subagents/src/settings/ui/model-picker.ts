import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
  createModelPickerChoices,
  makeModelPickerPage,
  type ModelPickerModel,
} from "pi-cosmic-ui/manager/model-picker";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
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

export type ProfileModelChoice =
  | { readonly kind: "model"; readonly selector: string }
  | { readonly kind: "parent" };

export interface ProfileModelPickerChoice {
  readonly choice: ProfileModelChoice;
  readonly item: SelectItem;
  readonly searchText: string;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable: boolean;
  readonly enabled?: boolean | undefined;
  readonly unavailableReason?: string | undefined;
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
    const fastModeAvailable = supportsSubagentFastMode("pi", canonical);
    const projected = createModelPickerChoices(
      [
        {
          ...model,
          description: sanitizeTerminalLine(
            `${model.name && model.name !== model.id ? `${boundedMiddle(sanitizeTerminalLine(model.name), 48)} · ` : ""}${model.reasoning ? "supports reasoning" : "no reasoning"} · reasoning levels: ${efforts.join(", ") || "none"}${fastModeAvailable ? " · fast mode available" : ""}`,
          ),
        },
      ],
      input.currentSelector,
    )[0]!;
    result.push({
      choice: { kind: "model", selector: canonical },
      item: projected.item,
      searchText: projected.searchText,
      supportedEfforts: efforts,
      fastModeAvailable,
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
  readonly scopedChoices?: ReadonlyArray<ProfileModelPickerChoice> | undefined;
  readonly initialSelection?: string | undefined;
  readonly context: ProfileModelPickerContext;
  readonly targetLabel?: string | undefined;
  readonly notice?: string | undefined;
  readonly select: (choice: ProfileModelChoice) => void;
  readonly cancel: () => void;
}

const runtimeLabel = (runtime: SubagentRuntime): string =>
  runtime === "pi" ? "Pi" : runtime === "claude" ? "Claude" : "Codex";

interface ProfilePickerModel extends ModelPickerModel {
  readonly choice: ProfileModelChoice;
}

const projectPickerChoices = (
  choices: ReadonlyArray<ProfileModelPickerChoice>,
): ProfilePickerModel[] =>
  choices.map((choice) => ({
    provider: "profile",
    id: choiceValue(choice.choice),
    selector: choiceValue(choice.choice),
    label: choice.item.label,
    description: choice.item.description,
    searchText: choice.searchText,
    available: choice.enabled !== false,
    unavailableReason: choice.unavailableReason,
    choice: choice.choice,
  }));

/** Full-page searchable model dropdown used inside the profile workspace. */
export const makeProfileModelPickerPage = (options: ProfileModelPickerPageOptions) => {
  const context = options.context;
  const host = context.host === "local" ? "Local" : "Herdr";
  const optionLabel = profileRouteOptionLabel(context.candidateIndex);
  return makeModelPickerPage({
    theme: options.theme,
    breadcrumb: `/subagents profiles › ${context.profile} › ${optionLabel} › Model`,
    title: `Choose model · ${context.profile} · ${optionLabel}`,
    subtitle: `${options.targetLabel ? `${options.targetLabel} · ` : ""}${host} ${runtimeLabel(context.runtime)}`,
    scopedModels: options.scopedChoices ? projectPickerChoices(options.scopedChoices) : [],
    allModels: projectPickerChoices(options.choices),
    current: options.initialSelection,
    notice: options.notice,
    getHeight: options.getHeight,
    requestRender: options.requestRender,
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: (model) => options.select(model.choice),
    cancel: options.cancel,
  });
};
