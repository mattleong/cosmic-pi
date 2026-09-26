// Pi registry and native model discovery are Promise-shaped settings boundaries.
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import * as Effect from "effect/Effect";
import { freezeSnapshot, sanitizeTerminalLine } from "pi-cosmic-core";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import {
  isSafeNativeModelSelector,
  PROFILE_NATIVE_MODEL_DEFAULTS,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import { runtimeEfforts, runtimeLabel } from "./profile-route-editor.ts";
import {
  createNativeModelOptions,
  createPiModelOptions,
  retainUnavailableCurrent,
  type ProfileModelOption,
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

const freezeCatalogSnapshot = (
  revision: number,
  models: ReadonlyArray<ProjectedPiModel>,
  scopedModels: ReadonlyArray<ProjectedPiModel> = models,
): ProfileModelCatalogSnapshot =>
  freezeSnapshot({ revision, piModels: models, scopedPiModels: scopedModels });

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

  refresh(): Effect.Effect<ProfileModelCatalogRefresh> {
    return Effect.suspend(() => {
      const generation = ++this.refreshGeneration;
      const stale = () => generation !== this.refreshGeneration;
      const retained = this.snapshot;
      return Effect.tryPromise({
        try: (signal) => this.registry.refresh({ signal }),
        catch: () => undefined,
      }).pipe(
        Effect.match({
          onFailure: () => (stale() ? "aborted" : "failed"),
          onSuccess: (refreshResult): ProfileModelCatalogRefresh => {
            if (refreshResult.aborted || stale()) return "aborted";
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
            if (!projected || stale()) return stale() ? "aborted" : "failed";
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
  readonly choices: ReadonlyArray<ProfileModelOption>;
  readonly scopedChoices?: ReadonlyArray<ProfileModelOption> | undefined;
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

const nativeFallbackModels = (
  runtime: LocalCliRuntime,
  current: string,
): ReadonlyArray<NativeRuntimeModel> =>
  [...new Set([current, PROFILE_NATIVE_MODEL_DEFAULTS[runtime]])].map((selector, index) => ({
    selector,
    label: selector,
    description: index === 0 ? "Current model" : `Default ${runtimeLabel(runtime)} model`,
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
    .then(() => input.listNativeModels(runtime, input.signal))
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
            : `Could not load ${runtimeLabel(runtime)} models. Showing the current and default models instead.`,
      }),
    )
    .then(({ models, warning }) => {
      const catalog = new Map<string, NativeRuntimeModel>();
      for (const model of [...models, ...nativeFallbackModels(runtime, input.candidate.model)])
        if (!catalog.has(model.selector)) catalog.set(model.selector, model);
      const base = {
        choices: createNativeModelOptions([...catalog.values()], input.candidate.model),
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

type PiModelOptionsInput = Pick<
  CandidateModelPickerInput,
  "candidate" | "piCatalog" | "parentSelector"
>;

/** Pi options for a candidate, from the full catalog unless a narrower model list is given. */
const piModelOptions = (
  { candidate, piCatalog, parentSelector }: PiModelOptionsInput,
  models = piCatalog.piModels,
) =>
  createPiModelOptions({
    models,
    parentModel: piCatalog.piModels.find((model) => canonicalPiSelector(model) === parentSelector),
    currentSelector: candidate.model,
    allowParent: candidate.host === "local",
  });

/** The efforts a Pi candidate's model offers, gated exactly as its picker gates them. */
export const supportedPiEfforts = (
  input: PiModelOptionsInput,
): ReadonlyArray<SubagentEffort> | undefined =>
  input.candidate.runtime === "pi"
    ? piModelOptions(input).find((option) => option.selector === input.candidate.model)
        ?.supportedEfforts
    : undefined;

/** Loads runtime-specific choices for the workspace's full-page searchable model picker. */
export function loadCandidateModelPicker(
  input: CandidateModelPickerInput,
): Promise<CandidateModelPickerData> {
  const candidate = input.candidate;
  if (candidate.runtime !== "pi") return loadNativeModels(input);
  // The root registry already reflects project trust; local and Herdr Pi use the same catalog.
  const snapshot = input.piCatalog;
  const optionsFor = (models: ReadonlyArray<ProjectedPiModel>) =>
    retainUnavailableCurrent(candidate.model, piModelOptions(input, models));
  const choices = optionsFor(snapshot.piModels);
  const unsafeModels = snapshot.piModels.filter(
    (model) => !isSafeNativeModelSelector(canonicalPiSelector(model)),
  ).length;
  const warnings = [
    choices[0]?.available === false
      ? "The configured model is not available right now. Keep it unchanged or choose another model."
      : undefined,
    unsafeModels > 0
      ? `${unsafeModels} model${unsafeModels === 1 ? " was" : "s were"} left out because the model name could not be used safely.`
      : undefined,
  ].filter((warning) => warning !== undefined);
  const base = {
    choices,
    scopedChoices: optionsFor(snapshot.scopedPiModels),
    current: candidate.model,
    context: pickerContext(input),
  };
  return Promise.resolve(warnings.length > 0 ? { ...base, warning: warnings.join(" ") } : base);
}
