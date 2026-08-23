// Settings model discovery is a Promise-shaped Pi host boundary.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LocalCliRuntime } from "../../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../../boundary/native-model-catalog.ts";
import type { ProfileCandidate, ProfileId } from "../../profiles/model.ts";
import {
  SUBAGENT_FAST_SERVICE_TIER,
  supportsSubagentFastMode,
  supportsSubagentFastModel,
} from "../../run/fast-mode.ts";
import { isSafeNativeModelSelector } from "../../run/native-model-selector.ts";
import {
  NATIVE_MODEL_DEFAULTS,
  runtimeEfforts,
  updateCandidateModel,
  type CandidateUpdate,
} from "../profile-route-editor.ts";
import {
  createNativeModelChoices,
  createProfileModelChoices,
  type ProfileModelChoice,
  type ProfileModelPickerChoice,
  type ProfileModelPickerContext,
} from "./model-picker.ts";

export interface CandidateModelEditorInput {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidate: ProfileCandidate;
  readonly listNativeModels: (
    runtime: LocalCliRuntime,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<NativeRuntimeModel>>;
  readonly piModels?: ReadonlyArray<Model<Api>> | undefined;
  readonly piParentModel?: Model<Api> | undefined;
  readonly registeredPiProviderIds?: ReadonlyArray<string> | undefined;
  readonly piProviderInspectionFailed?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CandidateModelPickerData {
  readonly choices: ReadonlyArray<ProfileModelPickerChoice>;
  readonly current: string;
  readonly defaultSelector?: string | undefined;
  readonly context: ProfileModelPickerContext;
  readonly warning?: string | undefined;
}

const selectedModelEfforts = (
  choices: ReadonlyArray<ProfileModelPickerChoice>,
  choice: ProfileModelChoice,
) =>
  choices.find((entry) =>
    choice.kind === "parent"
      ? entry.choice.kind === "parent"
      : entry.choice.kind === "model" && entry.choice.selector === choice.selector,
  )?.supportedEfforts;

const nativeFallbackModels = (
  runtime: LocalCliRuntime,
  current: string,
): ReadonlyArray<NativeRuntimeModel> =>
  [...new Set([current, NATIVE_MODEL_DEFAULTS[runtime]])].map((selector, index) => ({
    selector,
    label: selector,
    description: index === 0 ? "Current configured selector" : `Default ${runtime} model selector`,
    supportedEfforts: runtimeEfforts(runtime),
    supportedServiceTiers:
      runtime === "codex" && supportsSubagentFastModel("openai-codex", selector)
        ? [SUBAGENT_FAST_SERVICE_TIER]
        : [],
    isDefault: selector === NATIVE_MODEL_DEFAULTS[runtime],
  }));

const pickerContext = (input: CandidateModelEditorInput): ProfileModelPickerContext => ({
  profile: input.profile,
  candidateIndex: input.candidateIndex,
  host: input.candidate.host,
  runtime: input.candidate.runtime,
});

const loadNativeModels = (input: CandidateModelEditorInput): Promise<CandidateModelPickerData> => {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const runtime = input.candidate.runtime as LocalCliRuntime;
  return Promise.resolve()
    .then(() =>
      input.signal
        ? input.listNativeModels(runtime, input.signal)
        : input.listNativeModels(runtime),
    )
    .then(
      (advertised) => {
        const models = advertised.filter((model) => isSafeNativeModelSelector(model.selector));
        return {
          models,
          warning:
            models.length !== advertised.length
              ? "Some advertised models used unsafe selectors and were omitted."
              : undefined,
        };
      },
      (error) => ({
        // SAFETY: The empty fallback list trivially satisfies the declared element contract.
        models: [] as ReadonlyArray<NativeRuntimeModel>,
        warning:
          error instanceof Error
            ? `${error.message} Showing current/default model choices instead.`
            : `Could not load the ${runtime} model catalog. Showing current/default choices instead.`,
      }),
    )
    .then(({ models, warning }) => {
      const catalog = new Map<string, NativeRuntimeModel>();
      for (const model of [...models, ...nativeFallbackModels(runtime, input.candidate.model)])
        if (!catalog.has(model.selector)) catalog.set(model.selector, model);
      const baseResult = {
        choices: createNativeModelChoices([...catalog.values()], input.candidate.model),
        current: input.candidate.model,
        defaultSelector:
          models.find((model) => model.isDefault)?.selector ??
          models[0]?.selector ??
          input.candidate.model,
        context: pickerContext(input),
      };
      const withWarning = warning ? { ...baseResult, warning } : baseResult;
      return withWarning;
    });
};

/** Loads runtime-specific choices for the workspace's full-page searchable model picker. */
export function loadCandidateModelPicker(
  ctx: ExtensionCommandContext,
  input: CandidateModelEditorInput,
): Promise<CandidateModelPickerData> {
  const candidate = input.candidate;
  if (candidate.runtime !== "pi") return loadNativeModels(input);

  const registryModels = input.piModels ?? ctx.modelRegistry.getAvailable();
  let extensionProviders = new Set<string>();
  let providerInspectionFailed =
    candidate.host === "herdr" && input.piProviderInspectionFailed === true;
  if (candidate.host === "herdr" && !providerInspectionFailed) {
    if (input.registeredPiProviderIds) extensionProviders = new Set(input.registeredPiProviderIds);
    else
      try {
        extensionProviders = new Set(ctx.modelRegistry.getRegisteredProviderIds());
      } catch {
        providerInspectionFailed = true;
      }
  }
  const unavailableToHerdr =
    candidate.host === "herdr" && !providerInspectionFailed
      ? registryModels.filter((model) => extensionProviders.has(model.provider))
      : [];
  const availableModels =
    candidate.host === "herdr"
      ? providerInspectionFailed
        ? []
        : registryModels.filter((model) => !extensionProviders.has(model.provider))
      : registryModels;
  const parentModel =
    input.piParentModel ??
    (ctx.model ? ctx.modelRegistry.find(ctx.model.provider, ctx.model.id) : undefined);
  const advertisedChoices = createProfileModelChoices({
    models: availableModels,
    parentModel,
    currentSelector: candidate.model,
    allowParent: candidate.host === "local",
  });
  const currentAvailable = advertisedChoices.some((choice) =>
    candidate.model === "parent"
      ? choice.choice.kind === "parent"
      : choice.choice.kind === "model" && choice.choice.selector === candidate.model,
  );
  const currentSlash = candidate.model.indexOf("/");
  const currentProvider = currentSlash > 0 ? candidate.model.slice(0, currentSlash) : undefined;
  const currentUnavailableToHerdr =
    candidate.host === "herdr" &&
    currentProvider !== undefined &&
    extensionProviders.has(currentProvider);
  const unavailableCurrent: ProfileModelPickerChoice | undefined = currentAvailable
    ? undefined
    : {
        choice:
          candidate.model === "parent"
            ? { kind: "parent" }
            : { kind: "model", selector: candidate.model },
        item: {
          value: candidate.model,
          label: `${candidate.model} (current · unavailable)`,
          description: providerInspectionFailed
            ? "Keep the configured value or reopen after provider provenance is available"
            : currentUnavailableToHerdr
              ? "Herdr Pi disables extension providers; choose a compatible replacement"
              : "Keep the configured value or choose an authenticated replacement",
        },
        searchText: `${candidate.model} current unavailable configured`,
        fastModeAvailable:
          !providerInspectionFailed &&
          !currentUnavailableToHerdr &&
          supportsSubagentFastMode("pi", candidate.model),
      };
  const choices = unavailableCurrent
    ? [unavailableCurrent, ...advertisedChoices]
    : advertisedChoices;
  const unsafeModels = availableModels.filter(
    (model) => !isSafeNativeModelSelector(`${model.provider}/${model.id}`),
  ).length;
  const warnings = [
    providerInspectionFailed
      ? "Pi provider provenance is unavailable, so Herdr Pi model choices are hidden fail-closed."
      : unavailableCurrent
        ? currentUnavailableToHerdr
          ? "The configured model uses an extension-registered provider that sterile Herdr Pi cannot load. Keeping it makes no change; choose a compatible replacement."
          : "The configured model is not currently authenticated. Keeping it makes no change; choose another model to replace it."
        : undefined,
    unavailableToHerdr.length > 0
      ? `${unavailableToHerdr.length} authenticated model${unavailableToHerdr.length === 1 ? " was" : "s were"} omitted because Herdr Pi disables extension discovery.`
      : undefined,
    unsafeModels > 0
      ? `${unsafeModels} authenticated model${unsafeModels === 1 ? " was" : "s were"} omitted because the canonical selector is unsafe.`
      : undefined,
    choices.length === 0 ? "No authenticated canonical Pi models are available." : undefined,
  ].filter((warning): warning is string => warning !== undefined);
  return Promise.resolve(
    (() => {
      const baseResult = { choices, current: candidate.model, context: pickerContext(input) };
      const withWarning =
        warnings.length > 0 ? { ...baseResult, warning: warnings.join(" ") } : baseResult;
      return withWarning;
    })(),
  );
}

/** Applies a full-page picker selection through the route editor's normalization rules. */
export function updateCandidateFromModelChoice(
  candidate: ProfileCandidate,
  picker: CandidateModelPickerData,
  choice: ProfileModelChoice,
): CandidateUpdate {
  const model = choice.kind === "parent" ? "parent" : choice.selector;
  const selected = picker.choices.find((entry) =>
    choice.kind === "parent"
      ? entry.choice.kind === "parent"
      : entry.choice.kind === "model" && entry.choice.selector === choice.selector,
  );
  return updateCandidateModel(
    candidate,
    model,
    selectedModelEfforts(picker.choices, choice),
    selected?.fastModeAvailable,
  );
}
