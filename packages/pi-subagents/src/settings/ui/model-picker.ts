import * as Arr from "effect/Array";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  boundedMiddle,
  ModelPickerPage,
  type ModelPickerModel,
} from "pi-cosmic-ui/manager/model-picker";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import {
  isSafeNativeModelSelector,
  supportsSubagentFastMode,
  type ProfileId,
} from "../../profiles/model.ts";
import type { SubagentEffort } from "../../domain/routing.ts";
import type { ProjectedPiModel } from "../profile-model-catalog.ts";
import { profileRouteOptionLabel } from "../profile-route-editor.ts";
import { candidateModelLabel } from "./profile-workspace-model.ts";
import { profileBreadcrumb, selectHost } from "./profile-workspace-selectors.ts";

export interface ProfileModelOption extends ModelPickerModel {
  readonly selector: string;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly fastModeAvailable: boolean;
}

const pseudoModel = (selector: string) => ({ provider: "profile", id: selector, selector });

export function createPiModelOptions(input: {
  readonly models: ReadonlyArray<ProjectedPiModel>;
  readonly parentModel?: ProjectedPiModel | undefined;
}): ProfileModelOption[] {
  const models = Arr.flatMap(input.models, (model) => {
    const selector = `${model.provider}/${model.id}`;
    return isSafeNativeModelSelector(selector)
      ? [{ ...model, selector, fastModeAvailable: supportsSubagentFastMode(selector) }]
      : [];
  });
  const parent = input.parentModel;
  const canonical = parent ? `${parent.provider}/${parent.id}` : undefined;
  return [
    {
      ...pseudoModel("parent"),
      // The same name the editor gives an inherited model: `inherit (provider/model)`.
      label: candidateModelLabel(
        { model: "parent" },
        canonical === undefined ? undefined : boundedMiddle(sanitizeTerminalLine(canonical), 72),
      ),
      description: parent
        ? `${parent.name ? `${boundedMiddle(sanitizeTerminalLine(parent.name), 48)} · ` : ""}${parent.reasoning ? "supports reasoning" : "no reasoning"} · reasoning levels: ${Arr.join(parent.supportedEfforts, ", ") || "none"}`
        : "Inherit the current Pi model when this run starts",
      searchText: `inherit parent ${canonical ?? "active model"} ${parent?.name ?? ""}`,
      supportedEfforts: parent?.supportedEfforts,
      fastModeAvailable: canonical ? supportsSubagentFastMode(canonical) : false,
    },
    ...models,
  ];
}

export const retainUnavailableCurrent = (
  current: string,
  options: ReadonlyArray<ProfileModelOption>,
): ReadonlyArray<ProfileModelOption> =>
  Arr.some(options, (option) => option.selector === current)
    ? options
    : [
        {
          ...pseudoModel(current),
          label: `${current} (unavailable)`,
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
    breadcrumb: profileBreadcrumb(targetLabel, context.profile, optionLabel, "Model"),
    title: `Choose model · ${context.profile} · ${optionLabel}`,
    subtitle: targetLabel,
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
