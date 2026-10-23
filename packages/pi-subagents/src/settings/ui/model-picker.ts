import * as Arr from "effect/Array";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  boundedMiddle,
  ModelPickerPage,
  type ModelPickerModel,
} from "pi-cosmic-ui/manager/model-picker";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import { FAST_SERVICE_TIER } from "pi-better-openai/fast-models";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { NativeRuntimeModel } from "../../boundary/native-model-catalog.ts";
import {
  isSafeNativeModelSelector,
  supportsSubagentFastMode,
  type ProfileId,
} from "../../profiles/model.ts";
import type { SubagentEffort, SubagentRuntime } from "../../domain/routing.ts";
import type { ProjectedPiModel } from "../profile-model-catalog.ts";
import { profileRouteOptionLabel } from "../profile-route-editor.ts";
import { runWithLabel } from "./profile-workspace-model.ts";
import { selectHost } from "./profile-workspace-selectors.ts";

export interface ProfileModelOption extends ModelPickerModel {
  readonly selector: string;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable: boolean;
}

const pseudoModel = (selector: string) => ({ provider: "profile", id: selector, selector });

export function createPiModelOptions(input: {
  readonly models: ReadonlyArray<ProjectedPiModel>;
  readonly parentModel?: ProjectedPiModel | undefined;
  readonly currentSelector: string;
}): ProfileModelOption[] {
  const models = Arr.flatMap(input.models, (model) => {
    const selector = `${model.provider}/${model.id}`;
    return isSafeNativeModelSelector(selector)
      ? [{ ...model, selector, fastModeAvailable: supportsSubagentFastMode("pi", selector) }]
      : [];
  });
  const parent = input.parentModel;
  const canonical = parent ? `${parent.provider}/${parent.id}` : undefined;
  return [
    {
      ...pseudoModel("parent"),
      label: `Current Pi model${canonical ? ` → ${boundedMiddle(sanitizeTerminalLine(canonical), 72)}` : ""}${input.currentSelector === "parent" ? " (current)" : ""}`,
      description: parent
        ? `${parent.name ? `${boundedMiddle(sanitizeTerminalLine(parent.name), 48)} · ` : ""}${parent.reasoning ? "supports reasoning" : "no reasoning"} · reasoning levels: ${Arr.join(parent.supportedEfforts, ", ") || "none"}`
        : "Use the current Pi model when this run starts",
      searchText: `parent ${canonical ?? "active model"} ${parent?.name ?? ""}`,
      supportedEfforts: parent?.supportedEfforts,
      fastModeAvailable: canonical ? supportsSubagentFastMode("pi", canonical) : false,
    },
    ...models,
  ];
}

const nativeModelStatus = (
  model: NativeRuntimeModel,
  currentSelector: string | undefined,
): string => {
  const labels = Arr.filter(
    [
      model.isDefault ? "default" : undefined,
      model.selector === currentSelector ? "current" : undefined,
    ],
    (label) => label !== undefined,
  );
  return labels.length ? ` · ${Arr.join(labels, ", ")}` : "";
};

export const createNativeModelOptions = (
  models: ReadonlyArray<NativeRuntimeModel>,
  currentSelector: string | undefined,
): ProfileModelOption[] =>
  Arr.flatMap(models, (model) => {
    if (!isSafeNativeModelSelector(model.selector)) return [];
    const fastModeAvailable = model.supportedServiceTiers.includes(FAST_SERVICE_TIER);
    return [
      {
        provider: "profile",
        id: model.selector,
        selector: model.selector,
        label: `${boundedMiddle(sanitizeTerminalLine(model.selector), 72)}${nativeModelStatus(model, currentSelector)}`,
        description: `${model.label && model.label !== model.selector ? `${boundedMiddle(sanitizeTerminalLine(model.label), 72)} · ` : ""}${model.description ? `${boundedMiddle(sanitizeTerminalLine(model.description), 96)} · ` : ""}reasoning levels: ${Arr.join(model.supportedEfforts, ", ") || "default"}${fastModeAvailable ? " · fast mode available" : ""}`,
        searchText: `${model.selector} ${model.label} ${model.description ?? ""}`,
        supportedEfforts: model.supportedEfforts,
        fastModeAvailable,
      },
    ];
  });

export const retainUnavailableCurrent = (
  current: string,
  options: ReadonlyArray<ProfileModelOption>,
): ReadonlyArray<ProfileModelOption> =>
  Arr.some(options, (option) => option.selector === current)
    ? options
    : [
        {
          ...pseudoModel(current),
          label: `${current} (current · unavailable)`,
          searchText: `${current} current unavailable configured`,
          available: false,
          unavailableReason:
            "Configured model is unavailable; choose another model or cancel to keep it",
          fastModeAvailable: false,
        },
        ...options,
      ];

export interface ProfileModelPickerContext {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly runtime: SubagentRuntime;
}

interface ProfileModelPickerPageOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly choices: ReadonlyArray<ProfileModelOption>;
  readonly scopedChoices?: ReadonlyArray<ProfileModelOption> | undefined;
  readonly initialSelection?: string | undefined;
  readonly context: ProfileModelPickerContext;
  readonly targetLabel: string;
  readonly notice?: string | undefined;
  readonly select: (option: ProfileModelOption) => void;
  readonly cancel: () => void;
}

export const profileModelPickerPage = (options: ProfileModelPickerPageOptions) => {
  const { context, initialSelection, scopedChoices, targetLabel } = options;
  const optionLabel = profileRouteOptionLabel(context.candidateIndex);
  return new ModelPickerPage({
    ...selectHost(options),
    breadcrumb: `${targetLabel} · ${context.profile} · ${optionLabel} · Model`,
    title: `Choose model · ${context.profile} · ${optionLabel}`,
    subtitle: `${targetLabel} · ${runWithLabel(context)}`,
    scopedModels: scopedChoices ?? [],
    allModels: options.choices,
    current: initialSelection,
    initialSearchMode: true,
    initialScope:
      scopedChoices !== undefined &&
      Arr.some(scopedChoices, (option) => option.selector === initialSelection)
        ? "scoped"
        : "all",
    notice: options.notice,
    select: options.select,
    cancel: options.cancel,
  });
};
