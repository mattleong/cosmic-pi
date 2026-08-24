// Pi registry and native model discovery are Promise-shaped settings boundaries.
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import {
  isSafeNativeModelSelector,
  PROFILE_NATIVE_MODEL_DEFAULTS,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import {
  runtimeEfforts,
  updateCandidateModel,
  type CandidateUpdate,
} from "./profile-route-editor.ts";
import {
  createNativeModelChoices,
  createProfileModelChoices,
  type ProfileModelChoice,
  type ProfileModelPickerChoice,
  type ProfileModelPickerContext,
} from "./ui/model-picker.ts";

export interface ProjectedPiModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string | undefined;
  readonly reasoning: boolean;
  readonly supportedEfforts: ReadonlyArray<SubagentEffort>;
}

export interface ProfileModelCatalogSnapshot {
  readonly revision: number;
  readonly piModels: ReadonlyArray<ProjectedPiModel>;
  /** Undefined means provider provenance could not be inspected and Herdr Pi must fail closed. */
  readonly extensionProviderIds?: ReadonlyArray<string> | undefined;
}

export interface ProfileModelRegistryRefreshResult {
  readonly aborted: boolean;
  readonly errors?: ReadonlyMap<string, Error> | undefined;
}

export interface ProfileModelRegistry {
  readonly getAvailable: () => ReadonlyArray<Model<Api>>;
  readonly getRegisteredProviderIds: () => ReadonlyArray<string>;
  readonly getError: () => string | undefined;
  readonly refresh: (options?: {
    readonly signal: AbortSignal;
  }) => Promise<ProfileModelRegistryRefreshResult>;
}

export type ProfileModelCatalogRefresh = "updated" | "failed" | "aborted";

const freezeProjectedModel = (model: ProjectedPiModel): ProjectedPiModel =>
  Object.freeze({ ...model, supportedEfforts: Object.freeze([...model.supportedEfforts]) });

const freezeCatalogSnapshot = (
  revision: number,
  models: ReadonlyArray<ProjectedPiModel>,
  extensionProviderIds: ReadonlyArray<string> | undefined,
): ProfileModelCatalogSnapshot => {
  const base = {
    revision,
    piModels: Object.freeze(models.map(freezeProjectedModel)),
  };
  return Object.freeze(
    extensionProviderIds === undefined
      ? base
      : { ...base, extensionProviderIds: Object.freeze([...extensionProviderIds]) },
  );
};

const projectPiModel = (model: Model<Api>): ProjectedPiModel => {
  const efforts = getSupportedThinkingLevels(model).flatMap((effort) => {
    const decoded = decodeSubagentEffort(effort);
    return decoded ? [decoded] : [];
  });
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning === true,
    supportedEfforts: efforts,
  };
};

const projectRegistry = (
  registry: ProfileModelRegistry,
  revision: number,
  tolerateUnavailableProvenance = false,
): ProfileModelCatalogSnapshot | undefined => {
  try {
    const models = registry.getAvailable().map(projectPiModel);
    let extensionProviderIds: ReadonlyArray<string> | undefined;
    try {
      extensionProviderIds = [...registry.getRegisteredProviderIds()];
    } catch {
      if (!tolerateUnavailableProvenance) return undefined;
      // The initial snapshot remains coherent, but Herdr Pi choices fail closed without provenance.
    }
    return freezeCatalogSnapshot(revision, models, extensionProviderIds);
  } catch {
    return undefined;
  }
};

/** Replace-only in-memory catalog. Readers capture one immutable generation per action. */
export class ProfileModelCatalog {
  private snapshot: ProfileModelCatalogSnapshot;
  private refreshGeneration = 0;
  private readonly registry: ProfileModelRegistry;

  constructor(registry: ProfileModelRegistry) {
    this.registry = registry;
    this.snapshot = projectRegistry(registry, 0, true) ?? freezeCatalogSnapshot(0, [], undefined);
  }

  capture(): ProfileModelCatalogSnapshot {
    return this.snapshot;
  }

  refresh(signal?: AbortSignal): Promise<ProfileModelCatalogRefresh> {
    const generation = ++this.refreshGeneration;
    const retained = this.snapshot;
    if (signal?.aborted) return Promise.resolve("aborted");
    return Promise.resolve()
      .then(() => this.registry.refresh(signal ? { signal } : undefined))
      .then(
        (refreshResult) => {
          if (refreshResult.aborted || signal?.aborted || generation !== this.refreshGeneration)
            return "aborted" as const;
          if (refreshResult.errors && refreshResult.errors.size > 0) return "failed" as const;
          try {
            if (this.registry.getError()) return "failed" as const;
          } catch {
            return "failed" as const;
          }
          const projected = projectRegistry(this.registry, retained.revision + 1);
          if (!projected || signal?.aborted || generation !== this.refreshGeneration)
            return signal?.aborted || generation !== this.refreshGeneration
              ? ("aborted" as const)
              : ("failed" as const);
          this.snapshot = projected;
          return "updated" as const;
        },
        () =>
          signal?.aborted || generation !== this.refreshGeneration
            ? ("aborted" as const)
            : ("failed" as const),
      );
  }
}

const canonicalPiSelector = (model: ProjectedPiModel): string => `${model.provider}/${model.id}`;

export const preferredHerdrPiSelector = (
  snapshot: ProfileModelCatalogSnapshot,
  parentSelector?: string | undefined,
): string | undefined => {
  const extensionProviders = snapshot.extensionProviderIds;
  if (!extensionProviders) return undefined;
  const excluded = new Set(extensionProviders);
  const selectors = snapshot.piModels
    .filter((model) => !excluded.has(model.provider))
    .map(canonicalPiSelector)
    .filter(isSafeNativeModelSelector);
  return parentSelector && selectors.includes(parentSelector) ? parentSelector : selectors[0];
};

export interface CandidateModelPickerData {
  readonly choices: ReadonlyArray<ProfileModelPickerChoice>;
  readonly current: string;
  readonly defaultSelector?: string | undefined;
  readonly context: ProfileModelPickerContext;
  readonly warning?: string | undefined;
}

export interface CandidateModelPickerInput {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidate: ProfileCandidate;
  readonly listNativeModels: (
    runtime: LocalCliRuntime,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<NativeRuntimeModel>>;
  /** One immutable Pi catalog generation captured by the picker action. */
  readonly piCatalog: ProfileModelCatalogSnapshot;
  readonly parentSelector?: string | undefined;
  readonly signal?: AbortSignal | undefined;
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
  [...new Set([current, PROFILE_NATIVE_MODEL_DEFAULTS[runtime]])].map((selector, index) => ({
    selector,
    label: selector,
    description: index === 0 ? "Current configured selector" : `Default ${runtime} model selector`,
    supportedEfforts: runtimeEfforts(runtime),
    // Fast mode for Codex is live catalog data. Fallback selectors never infer a tier.
    supportedServiceTiers: [],
    isDefault: selector === PROFILE_NATIVE_MODEL_DEFAULTS[runtime],
  }));

const pickerContext = (input: CandidateModelPickerInput): ProfileModelPickerContext => ({
  profile: input.profile,
  candidateIndex: input.candidateIndex,
  host: input.candidate.host,
  runtime: input.candidate.runtime,
});

interface NativeModelLoadFailure {
  readonly models: ReadonlyArray<NativeRuntimeModel>;
  readonly warning: string;
}

const loadNativeModels = (input: CandidateModelPickerInput): Promise<CandidateModelPickerData> => {
  // SAFETY: The caller branches away from Pi immediately before entering this function.
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
      (error): NativeModelLoadFailure => ({
        models: [],
        warning:
          error instanceof Error
            ? `${sanitizeTerminalLine(error.message)} Showing current/default model choices instead.`
            : `Could not load the ${runtime} model catalog. Showing current/default choices instead.`,
      }),
    )
    .then(({ models, warning }) => {
      const catalog = new Map<string, NativeRuntimeModel>();
      for (const model of [...models, ...nativeFallbackModels(runtime, input.candidate.model)])
        if (!catalog.has(model.selector)) catalog.set(model.selector, model);
      const base = {
        choices: createNativeModelChoices([...catalog.values()], input.candidate.model),
        current: input.candidate.model,
        defaultSelector:
          models.find((model) => model.isDefault)?.selector ??
          models[0]?.selector ??
          input.candidate.model,
        context: pickerContext(input),
      };
      return warning ? { ...base, warning: sanitizeTerminalLine(warning) } : base;
    });
};

/** Loads runtime-specific choices for the workspace's full-page searchable model picker. */
export function loadCandidateModelPicker(
  input: CandidateModelPickerInput,
): Promise<CandidateModelPickerData> {
  const candidate = input.candidate;
  if (candidate.runtime !== "pi") return loadNativeModels(input);

  const snapshot = input.piCatalog;
  const extensionProviders = snapshot.extensionProviderIds
    ? new Set(snapshot.extensionProviderIds)
    : undefined;
  const providerInspectionFailed = candidate.host === "herdr" && !extensionProviders;
  const unavailableToHerdr =
    candidate.host === "herdr" && extensionProviders
      ? snapshot.piModels.filter((model) => extensionProviders.has(model.provider))
      : [];
  const availableModels =
    candidate.host === "herdr"
      ? extensionProviders
        ? snapshot.piModels.filter((model) => !extensionProviders.has(model.provider))
        : []
      : snapshot.piModels;
  const parentModel = input.parentSelector
    ? snapshot.piModels.find((model) => canonicalPiSelector(model) === input.parentSelector)
    : undefined;
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
    extensionProviders?.has(currentProvider) === true;
  const unavailableCurrent: ProfileModelPickerChoice | undefined = currentAvailable
    ? undefined
    : {
        choice:
          candidate.model === "parent"
            ? { kind: "parent" }
            : { kind: "model", selector: candidate.model },
        item: {
          value: candidate.model,
          label: sanitizeTerminalLine(`${candidate.model} (current · unavailable)`),
          description: sanitizeTerminalLine(
            providerInspectionFailed
              ? "Keep the configured value or reopen after provider provenance is available"
              : currentUnavailableToHerdr
                ? "Herdr Pi disables extension providers; choose a compatible replacement"
                : "Keep the configured value or choose an authenticated replacement",
          ),
        },
        searchText: sanitizeTerminalLine(`${candidate.model} current unavailable configured`),
        fastModeAvailable:
          !providerInspectionFailed &&
          !currentUnavailableToHerdr &&
          advertisedChoices.some(
            (choice) =>
              choice.choice.kind === "model" &&
              choice.choice.selector === candidate.model &&
              choice.fastModeAvailable,
          ),
      };
  const choices = unavailableCurrent
    ? [unavailableCurrent, ...advertisedChoices]
    : advertisedChoices;
  const unsafeModels = availableModels.filter(
    (model) => !isSafeNativeModelSelector(canonicalPiSelector(model)),
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
  ].flatMap((warning) => (warning === undefined ? [] : [sanitizeTerminalLine(warning)]));
  const base = {
    choices,
    current: candidate.model,
    context: pickerContext(input),
  };
  return Promise.resolve(warnings.length > 0 ? { ...base, warning: warnings.join(" ") } : base);
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
