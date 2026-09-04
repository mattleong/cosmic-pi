// Pi registry and native model discovery are Promise-shaped settings boundaries.
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import * as Effect from "effect/Effect";
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
  readonly scopedPiModels: ReadonlyArray<ProjectedPiModel>;
}

export interface ProfileModelRegistryRefreshResult {
  readonly aborted: boolean;
  readonly errors?: ReadonlyMap<string, Error> | undefined;
}

export interface ProfileModelRegistry {
  readonly getAvailable: () => ReadonlyArray<Model<Api>>;
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
  scopedModels: ReadonlyArray<ProjectedPiModel> = models,
): ProfileModelCatalogSnapshot =>
  Object.freeze({
    revision,
    piModels: Object.freeze(models.map(freezeProjectedModel)),
    scopedPiModels: Object.freeze(scopedModels.map(freezeProjectedModel)),
  });

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
  scopedSelectors: ReadonlySet<string>,
): ProfileModelCatalogSnapshot | undefined => {
  try {
    const models = registry.getAvailable().map(projectPiModel);
    const scopedModels =
      scopedSelectors.size === 0
        ? models
        : models.filter((model) => scopedSelectors.has(`${model.provider}/${model.id}`));
    return freezeCatalogSnapshot(revision, models, scopedModels);
  } catch {
    return undefined;
  }
};

/** Replace-only in-memory catalog. Readers capture one immutable generation per action. */
export class ProfileModelCatalog {
  private snapshot: ProfileModelCatalogSnapshot;
  private refreshGeneration = 0;
  private readonly registry: ProfileModelRegistry;
  private readonly scopedSelectors: ReadonlySet<string>;

  constructor(registry: ProfileModelRegistry, scopedModels: ReadonlyArray<Model<Api>> = []) {
    this.registry = registry;
    this.scopedSelectors = new Set(scopedModels.map((model) => `${model.provider}/${model.id}`));
    this.snapshot =
      projectRegistry(registry, 0, this.scopedSelectors) ?? freezeCatalogSnapshot(0, []);
  }

  capture(): ProfileModelCatalogSnapshot {
    return this.snapshot;
  }

  refresh(signal?: AbortSignal): Effect.Effect<ProfileModelCatalogRefresh> {
    return Effect.suspend(() => {
      const generation = ++this.refreshGeneration;
      const retained = this.snapshot;
      if (signal?.aborted) return Effect.succeed("aborted" as const);
      return Effect.tryPromise({
        try: (effectSignal) => this.registry.refresh({ signal: signal ?? effectSignal }),
        catch: () => undefined,
      }).pipe(
        Effect.match({
          onFailure: () =>
            signal?.aborted || generation !== this.refreshGeneration ? "aborted" : "failed",
          onSuccess: (refreshResult): ProfileModelCatalogRefresh => {
            if (refreshResult.aborted || signal?.aborted || generation !== this.refreshGeneration)
              return "aborted";
            if (refreshResult.errors && refreshResult.errors.size > 0) return "failed";
            try {
              if (this.registry.getError()) return "failed";
            } catch {
              return "failed";
            }
            const projected = projectRegistry(
              this.registry,
              retained.revision + 1,
              this.scopedSelectors,
            );
            if (!projected || signal?.aborted || generation !== this.refreshGeneration)
              return signal?.aborted || generation !== this.refreshGeneration
                ? "aborted"
                : "failed";
            this.snapshot = projected;
            return "updated";
          },
        }),
      );
    });
  }
}

const canonicalPiSelector = (model: ProjectedPiModel): string => `${model.provider}/${model.id}`;

export const preferredHerdrPiSelector = (
  snapshot: ProfileModelCatalogSnapshot,
  parentSelector?: string | undefined,
): string | undefined => {
  const selectors = snapshot.piModels.map(canonicalPiSelector).filter(isSafeNativeModelSelector);
  return parentSelector && selectors.includes(parentSelector) ? parentSelector : selectors[0];
};

export interface CandidateModelPickerData {
  readonly choices: ReadonlyArray<ProfileModelPickerChoice>;
  readonly scopedChoices?: ReadonlyArray<ProfileModelPickerChoice> | undefined;
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
    description:
      index === 0 ? "Current model" : `Default ${runtime === "claude" ? "Claude" : "Codex"} model`,
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
              ? "Some model names could not be used safely and were left out."
              : undefined,
        };
      },
      (error): NativeModelLoadFailure => ({
        models: [],
        warning:
          error instanceof Error
            ? `${sanitizeTerminalLine(error.message)} Showing the current and default models instead.`
            : `Could not load ${runtime === "claude" ? "Claude" : "Codex"} models. Showing the current and default models instead.`,
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

const unavailableCurrentChoice = (
  candidate: ProfileCandidate,
  advertisedChoices: ReadonlyArray<ProfileModelPickerChoice>,
): ProfileModelPickerChoice | undefined => {
  const currentAvailable = advertisedChoices.some((choice) =>
    candidate.model === "parent"
      ? choice.choice.kind === "parent"
      : choice.choice.kind === "model" && choice.choice.selector === candidate.model,
  );
  if (currentAvailable) return undefined;
  return {
    choice:
      candidate.model === "parent"
        ? { kind: "parent" }
        : { kind: "model", selector: candidate.model },
    item: {
      value: candidate.model,
      label: sanitizeTerminalLine(`${candidate.model} (current · unavailable)`),
      description: sanitizeTerminalLine(
        "Keep the configured value or choose an available replacement",
      ),
    },
    searchText: sanitizeTerminalLine(`${candidate.model} current unavailable configured`),
    enabled: false,
    unavailableReason: "Configured model is unavailable; choose another model or cancel to keep it",
    fastModeAvailable: advertisedChoices.some(
      (choice) =>
        choice.choice.kind === "model" &&
        choice.choice.selector === candidate.model &&
        choice.fastModeAvailable,
    ),
  };
};

const retainCurrentChoice = (
  candidate: ProfileCandidate,
  advertisedChoices: ReadonlyArray<ProfileModelPickerChoice>,
): ReadonlyArray<ProfileModelPickerChoice> => {
  const unavailable = unavailableCurrentChoice(candidate, advertisedChoices);
  return unavailable ? [unavailable, ...advertisedChoices] : advertisedChoices;
};

/** Loads runtime-specific choices for the workspace's full-page searchable model picker. */
export function loadCandidateModelPicker(
  input: CandidateModelPickerInput,
): Promise<CandidateModelPickerData> {
  const candidate = input.candidate;
  if (candidate.runtime !== "pi") return loadNativeModels(input);

  const snapshot = input.piCatalog;
  // The root registry already reflects project trust; local and Herdr Pi use the same catalog.
  const availableModels = snapshot.piModels;
  const parentModel = input.parentSelector
    ? snapshot.piModels.find((model) => canonicalPiSelector(model) === input.parentSelector)
    : undefined;
  const advertisedChoices = createProfileModelChoices({
    models: availableModels,
    parentModel,
    currentSelector: candidate.model,
    allowParent: candidate.host === "local",
  });
  const scopedAdvertisedChoices = createProfileModelChoices({
    models: snapshot.scopedPiModels,
    parentModel,
    currentSelector: candidate.model,
    allowParent: candidate.host === "local",
  });
  const unavailableCurrent = unavailableCurrentChoice(candidate, advertisedChoices);
  const choices = unavailableCurrent
    ? [unavailableCurrent, ...advertisedChoices]
    : advertisedChoices;
  const scopedChoices = retainCurrentChoice(candidate, scopedAdvertisedChoices);
  const unsafeModels = availableModels.filter(
    (model) => !isSafeNativeModelSelector(canonicalPiSelector(model)),
  ).length;
  const warnings = [
    unavailableCurrent
      ? "The configured model is not available right now. Keep it unchanged or choose another model."
      : undefined,
    unsafeModels > 0
      ? `${unsafeModels} model${unsafeModels === 1 ? " was" : "s were"} left out because the model name could not be used safely.`
      : undefined,
    choices.length === 0 ? "No available Pi models can be used here." : undefined,
  ].flatMap((warning) => (warning === undefined ? [] : [sanitizeTerminalLine(warning)]));
  const base = {
    choices,
    scopedChoices,
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
