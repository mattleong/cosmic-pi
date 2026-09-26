import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  boundedMiddle,
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
import { profileRouteOptionLabel, runWithLabel } from "./profile-workspace-model.ts";

/** A shared picker row plus the capabilities its selection applies to the candidate. */
export interface ProfileModelOption extends ModelPickerModel {
  readonly selector: string;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable: boolean;
}

// Parent, native, and unavailable rows have explicit labels; only the selector identifies them.
const pseudoModel = (selector: string) => ({ provider: "profile", id: selector, selector });

/** Authenticated canonical Pi models, plus local Pi's special parent selector. */
export function createPiModelOptions(input: {
  readonly models: ReadonlyArray<ProjectedPiModel>;
  readonly parentModel?: ProjectedPiModel | undefined;
  readonly currentSelector: string;
  readonly allowParent: boolean;
}): ProfileModelOption[] {
  const models = input.models.flatMap((model) => {
    const selector = `${model.provider}/${model.id}`;
    return isSafeNativeModelSelector(selector)
      ? [{ ...model, selector, fastModeAvailable: supportsSubagentFastMode("pi", selector) }]
      : [];
  });
  if (!input.allowParent) return models;
  const parent = input.parentModel;
  const canonical = parent ? `${parent.provider}/${parent.id}` : undefined;
  return [
    {
      ...pseudoModel("parent"),
      label: `Current Pi model${canonical ? ` → ${boundedMiddle(sanitizeTerminalLine(canonical), 72)}` : ""}${input.currentSelector === "parent" ? " (current)" : ""}`,
      description: parent
        ? `${parent.name ? `${boundedMiddle(sanitizeTerminalLine(parent.name), 48)} · ` : ""}${parent.reasoning ? "supports reasoning" : "no reasoning"} · reasoning levels: ${parent.supportedEfforts.join(", ") || "none"}`
        : "Use the current Pi model when this run starts",
      searchText: `parent ${canonical ?? "active model"} ${parent?.name ?? ""}`,
      supportedEfforts: parent?.supportedEfforts,
      fastModeAvailable: canonical ? supportsSubagentFastMode("pi", canonical) : false,
    },
    ...models,
  ];
}

const nativeModelStatus = (model: NativeRuntimeModel, currentSelector: string): string => {
  const labels = [
    model.isDefault ? "default" : undefined,
    model.selector === currentSelector ? "current" : undefined,
  ].filter((label) => label !== undefined);
  return labels.length ? ` · ${labels.join(", ")}` : "";
};

export const createNativeModelOptions = (
  models: ReadonlyArray<NativeRuntimeModel>,
  currentSelector: string,
): ProfileModelOption[] =>
  models
    .filter((model) => isSafeNativeModelSelector(model.selector))
    .map((model) => {
      const fastModeAvailable = model.supportedServiceTiers.includes(FAST_SERVICE_TIER);
      return {
        ...pseudoModel(model.selector),
        label: `${boundedMiddle(sanitizeTerminalLine(model.selector), 72)}${nativeModelStatus(model, currentSelector)}`,
        description: `${model.label && model.label !== model.selector ? `${boundedMiddle(sanitizeTerminalLine(model.label), 72)} · ` : ""}${model.description ? `${boundedMiddle(sanitizeTerminalLine(model.description), 96)} · ` : ""}reasoning levels: ${model.supportedEfforts.join(", ") || "default"}${fastModeAvailable ? " · fast mode available" : ""}`,
        searchText: `${model.selector} ${model.label} ${model.description ?? ""}`,
        supportedEfforts: model.supportedEfforts,
        fastModeAvailable,
      };
    });

/** Keeps a configured model that the list does not offer as its first, non-selectable row. */
export const retainUnavailableCurrent = (
  current: string,
  options: ReadonlyArray<ProfileModelOption>,
): ReadonlyArray<ProfileModelOption> =>
  options.some((option) => option.selector === current)
    ? options
    : [
        {
          ...pseudoModel(current),
          label: `${current} (current · unavailable)`,
          searchText: `${current} current unavailable configured`,
          available: false,
          unavailableReason:
            "Configured model is unavailable; choose another model or cancel to keep it",
          // Explicitly false, so the fast-mode picker never falls back to the global check.
          fastModeAvailable: false,
        },
        ...options,
      ];

export interface ProfileModelPickerContext {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
}

export interface ProfileModelPickerPageOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly choices: ReadonlyArray<ProfileModelOption>;
  readonly scopedChoices?: ReadonlyArray<ProfileModelOption> | undefined;
  readonly initialSelection?: string | undefined;
  readonly context: ProfileModelPickerContext;
  readonly targetLabel?: string | undefined;
  readonly notice?: string | undefined;
  readonly select: (option: ProfileModelOption) => void;
  readonly cancel: () => void;
}

/** Full-page searchable model dropdown used inside the profile workspace. */
export const makeProfileModelPickerPage = (options: ProfileModelPickerPageOptions) => {
  const { context, initialSelection, scopedChoices, targetLabel } = options;
  const optionLabel = profileRouteOptionLabel(context.candidateIndex);
  return makeModelPickerPage({
    theme: options.theme,
    breadcrumb: `${targetLabel ?? "/subagents profiles"} · ${context.profile} · ${optionLabel} · Model`,
    title: `Choose model · ${context.profile} · ${optionLabel}`,
    subtitle: `${targetLabel ? `${targetLabel} · ` : ""}${runWithLabel(context)}`,
    scopedModels: scopedChoices ?? [],
    allModels: options.choices,
    // Pi rows mark "(current)" from this; the Pi loader sets no defaultSelector, so it is the model.
    current: initialSelection,
    initialSearchMode: true,
    initialScope: scopedChoices?.some((option) => option.selector === initialSelection)
      ? "scoped"
      : "all",
    notice: options.notice,
    getHeight: options.getHeight,
    requestRender: options.requestRender,
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: options.select,
    cancel: options.cancel,
  });
};
