import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import * as Effect from "effect/Effect";
import { freezeSnapshot, sanitizeTerminalLine } from "pi-cosmic-core";
import type { LocalCliRuntime } from "../boundary/local-cli-process.ts";
import type { NativeRuntimeModel } from "../boundary/native-model-catalog.ts";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import {
  isSafeNativeModelSelector,
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

interface ProfileModelCatalogSnapshot {
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

type ProfileModelCatalogRefresh = "updated" | "failed" | "aborted";

const freezeCatalogSnapshot = (
  models: ReadonlyArray<ProjectedPiModel>,
  scopedModels: ReadonlyArray<ProjectedPiModel> = models,
): ProfileModelCatalogSnapshot =>
  freezeSnapshot({ piModels: models, scopedPiModels: scopedModels });

const projectPiModel = (model: Model<Api>): ProjectedPiModel => {
  const efforts = getSupportedThinkingLevels(model).flatMap((effort) => {
    const decoded = decodeSubagentEffort(effort);
    return decoded ? [decoded] : [];
  });
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    supportedEfforts: efforts,
  };
};

const projectRegistry = (
  registry: ProfileModelRegistry,
  scopedSelectors: ReadonlySet<string>,
): ProfileModelCatalogSnapshot | undefined => {
  try {
    const models = registry.getAvailable().map(projectPiModel);
    const scopedModels =
      scopedSelectors.size === 0
        ? models
        : models.filter((model) => scopedSelectors.has(`${model.provider}/${model.id}`));
    return freezeCatalogSnapshot(models, scopedModels);
  } catch {
    return undefined;
  }
};

export class ProfileModelCatalog {
  private snapshot: ProfileModelCatalogSnapshot;
  private readonly registry: ProfileModelRegistry;
  private readonly scopedSelectors: ReadonlySet<string>;

  constructor(registry: ProfileModelRegistry, scopedModels: ReadonlyArray<Model<Api>> = []) {
    this.registry = registry;
    this.scopedSelectors = new Set(scopedModels.map((model) => `${model.provider}/${model.id}`));
    this.snapshot = projectRegistry(registry, this.scopedSelectors) ?? freezeCatalogSnapshot([]);
  }

  capture(): ProfileModelCatalogSnapshot {
    return this.snapshot;
  }

  refresh(): Effect.Effect<ProfileModelCatalogRefresh> {
    return Effect.tryPromise({
      try: (signal) => this.registry.refresh({ signal }),
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onFailure: () => "failed",
        onSuccess: (refreshResult): ProfileModelCatalogRefresh => {
          if (refreshResult.aborted) return "aborted";
          if (refreshResult.errors && refreshResult.errors.size > 0) return "failed";
          try {
            if (this.registry.getError()) return "failed";
          } catch {
            return "failed";
          }
          const projected = projectRegistry(this.registry, this.scopedSelectors);
          if (!projected) return "failed";
          this.snapshot = projected;
          return "updated";
        },
      }),
    );
  }
}

const canonicalPiSelector = (model: ProjectedPiModel): string => `${model.provider}/${model.id}`;

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
  readonly piCatalog: ProfileModelCatalogSnapshot;
  readonly parentSelector?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly modelPending?: boolean | undefined;
}

const configuredNativeModel = (runtime: LocalCliRuntime, current: string): NativeRuntimeModel => ({
  selector: current,
  label: current,
  description: "Current model",
  supportedEfforts: runtimeEfforts(runtime),
  supportedServiceTiers: [],
  isDefault: false,
});

const pickerContext = (input: CandidateModelPickerInput): ProfileModelPickerContext => ({
  profile: input.profile,
  candidateIndex: input.candidateIndex,
  runtime: input.candidate.runtime,
});

interface NativeModelLoadFailure {
  readonly models: ReadonlyArray<NativeRuntimeModel>;
  readonly warning: string;
}

const loadNativeModels = (
  input: CandidateModelPickerInput,
  runtime: LocalCliRuntime,
): Promise<CandidateModelPickerData> =>
  Promise.resolve()
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
      (cause: unknown): NativeModelLoadFailure => ({
        models: [],
        warning: `${
          cause instanceof Error
            ? sanitizeTerminalLine(cause.message)
            : `Could not load ${runtimeLabel(runtime)} models.`
        }${input.modelPending ? "" : " Showing the current model instead."}`,
      }),
    )
    .then(({ models, warning }) => {
      const current = input.modelPending ? undefined : input.candidate.model;
      const catalog = new Map<string, NativeRuntimeModel>();
      for (const model of [
        ...models,
        ...(current ? [configuredNativeModel(runtime, current)] : []),
      ])
        if (!catalog.has(model.selector)) catalog.set(model.selector, model);
      const base = {
        choices: createNativeModelOptions([...catalog.values()], current),
        current: input.candidate.model,
        defaultSelector:
          models.find((model) => model.isDefault)?.selector ??
          models[0]?.selector ??
          input.candidate.model,
        context: pickerContext(input),
      };
      return warning ? { ...base, warning: sanitizeTerminalLine(warning) } : base;
    });

type PiModelOptionsInput = Pick<
  CandidateModelPickerInput,
  "candidate" | "piCatalog" | "parentSelector"
>;

const piModelOptions = (
  { candidate, piCatalog, parentSelector }: PiModelOptionsInput,
  models = piCatalog.piModels,
) =>
  createPiModelOptions({
    models,
    parentModel: piCatalog.piModels.find((model) => canonicalPiSelector(model) === parentSelector),
    currentSelector: candidate.model,
  });

export const supportedPiEfforts = (
  input: PiModelOptionsInput,
): ReadonlyArray<SubagentEffort> | undefined =>
  input.candidate.runtime === "pi"
    ? piModelOptions(input).find((option) => option.selector === input.candidate.model)
        ?.supportedEfforts
    : undefined;

export function loadCandidateModelPicker(
  input: CandidateModelPickerInput,
): Promise<CandidateModelPickerData> {
  const candidate = input.candidate;
  if (candidate.runtime !== "pi") return loadNativeModels(input, candidate.runtime);
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
