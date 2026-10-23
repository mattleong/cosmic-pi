import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
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
  const efforts = Arr.flatMap(getSupportedThinkingLevels(model), (effort) => {
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
    const models = Arr.map(registry.getAvailable(), projectPiModel);
    const scopedModels =
      scopedSelectors.size === 0
        ? models
        : Arr.filter(models, (model) => scopedSelectors.has(`${model.provider}/${model.id}`));
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
    this.scopedSelectors = new Set(
      Arr.map(scopedModels, (model) => `${model.provider}/${model.id}`),
    );
    this.snapshot = projectRegistry(registry, this.scopedSelectors) ?? freezeCatalogSnapshot([]);
  }

  capture(): ProfileModelCatalogSnapshot {
    return this.snapshot;
  }

  refresh(): Effect.Effect<ProfileModelCatalogRefresh> {
    // A registry that throws or reports an error leaves the previous snapshot in place.
    const projectRefreshed = Effect.try(() =>
      this.registry.getError() ? undefined : projectRegistry(this.registry, this.scopedSelectors),
    );
    return Effect.tryPromise((signal) => this.registry.refresh({ signal })).pipe(
      Effect.flatMap((refreshResult) =>
        refreshResult.aborted
          ? Effect.succeed<ProfileModelCatalogRefresh>("aborted")
          : refreshResult.errors && refreshResult.errors.size > 0
            ? Effect.succeed<ProfileModelCatalogRefresh>("failed")
            : projectRefreshed.pipe(
                Effect.flatMap((projected) =>
                  projected
                    ? Effect.sync(() => {
                        this.snapshot = projected;
                      }).pipe(Effect.as<ProfileModelCatalogRefresh>("updated"))
                    : Effect.succeed<ProfileModelCatalogRefresh>("failed"),
                ),
              ),
      ),
      Effect.orElseSucceed((): ProfileModelCatalogRefresh => "failed"),
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
        const models = Arr.filter(advertised, (model) => isSafeNativeModelSelector(model.selector));
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
          Option.getOrUndefined(Arr.findFirst(models, (model) => model.isDefault))?.selector ??
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
    parentModel: Option.getOrUndefined(
      Arr.findFirst(piCatalog.piModels, (model) => canonicalPiSelector(model) === parentSelector),
    ),
    currentSelector: candidate.model,
  });

export const supportedPiEfforts = (
  input: PiModelOptionsInput,
): ReadonlyArray<SubagentEffort> | undefined =>
  input.candidate.runtime === "pi"
    ? Option.getOrUndefined(
        Arr.findFirst(piModelOptions(input), (option) => option.selector === input.candidate.model),
      )?.supportedEfforts
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
  const unsafeModels = Arr.filter(
    snapshot.piModels,
    (model) => !isSafeNativeModelSelector(canonicalPiSelector(model)),
  ).length;
  const warnings = Arr.filter(
    [
      choices[0]?.available === false
        ? "The configured model is not available right now. Keep it unchanged or choose another model."
        : undefined,
      unsafeModels > 0
        ? `${unsafeModels} model${unsafeModels === 1 ? " was" : "s were"} left out because the model name could not be used safely.`
        : undefined,
    ],
    (warning) => warning !== undefined,
  );
  const base = {
    choices,
    scopedChoices: optionsFor(snapshot.scopedPiModels),
    current: candidate.model,
    context: pickerContext(input),
  };
  return Promise.resolve(
    warnings.length > 0 ? { ...base, warning: Arr.join(warnings, " ") } : base,
  );
}
