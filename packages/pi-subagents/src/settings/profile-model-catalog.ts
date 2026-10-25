import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import {
  isSafeNativeModelSelector,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import {
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
  readonly context: ProfileModelPickerContext;
  readonly warning?: string | undefined;
}

export interface CandidateModelPickerInput {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidate: ProfileCandidate;
  readonly piCatalog: ProfileModelCatalogSnapshot;
  readonly parentSelector?: string | undefined;
}

const pickerContext = (input: CandidateModelPickerInput): ProfileModelPickerContext => ({
  profile: input.profile,
  candidateIndex: input.candidateIndex,
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
  Option.getOrUndefined(
    Arr.findFirst(piModelOptions(input), (option) => option.selector === input.candidate.model),
  )?.supportedEfforts;

export function loadCandidateModelPicker(
  input: CandidateModelPickerInput,
): Promise<CandidateModelPickerData> {
  const candidate = input.candidate;
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
