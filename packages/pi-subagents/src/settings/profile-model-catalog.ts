import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import { modelSelector } from "pi-cosmic-ui/manager/model-picker";
import { decodeSubagentEffort, type SubagentEffort } from "../domain/routing.ts";
import { isSafeNativeModelSelector, type ProfileCandidate } from "../profiles/model.ts";
import {
  createPiModelOptions,
  retainUnavailableCurrent,
  type ProfileModelOption,
} from "./ui/model-picker.ts";
import { findOrUndefined } from "pi-cosmic-core/array";

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
): ProfileModelCatalogSnapshot | undefined =>
  invokeHostCallback(() => {
    const models = Arr.map(registry.getAvailable(), projectPiModel);
    const scopedModels =
      scopedSelectors.size === 0
        ? models
        : Arr.filter(models, (model) => scopedSelectors.has(modelSelector(model)));
    return freezeCatalogSnapshot(models, scopedModels);
  }, undefined);

export class ProfileModelCatalog {
  private snapshot: ProfileModelCatalogSnapshot;
  private readonly registry: ProfileModelRegistry;
  private readonly scopedSelectors: ReadonlySet<string>;

  constructor(registry: ProfileModelRegistry, scopedModels: ReadonlyArray<Model<Api>> = []) {
    this.registry = registry;
    this.scopedSelectors = new Set(Arr.map(scopedModels, (model) => modelSelector(model)));
    this.snapshot = projectRegistry(registry, this.scopedSelectors) ?? freezeCatalogSnapshot([]);
  }

  capture(): ProfileModelCatalogSnapshot {
    return this.snapshot;
  }

  refresh(): Effect.Effect<ProfileModelCatalogRefresh> {
    return Effect.gen({ self: this }, function* () {
      const refreshResult = yield* Effect.tryPromise((signal) => this.registry.refresh({ signal }));
      if (refreshResult.aborted) return "aborted" as const;
      if (refreshResult.errors && refreshResult.errors.size > 0) return "failed" as const;
      // A registry that throws or reports an error leaves the previous snapshot in place.
      const projected = yield* Effect.try(() =>
        this.registry.getError() ? undefined : projectRegistry(this.registry, this.scopedSelectors),
      );
      if (!projected) return "failed" as const;
      this.snapshot = projected;
      return "updated" as const;
    }).pipe(Effect.orElseSucceed((): ProfileModelCatalogRefresh => "failed"));
  }
}

export interface CandidateModelPickerData {
  readonly choices: ReadonlyArray<ProfileModelOption>;
  readonly scopedChoices?: ReadonlyArray<ProfileModelOption> | undefined;
  readonly warning?: string | undefined;
}

interface CandidateModelPickerInput {
  readonly candidate: ProfileCandidate;
  readonly piCatalog: ProfileModelCatalogSnapshot;
  readonly parentSelector?: string | undefined;
}

const piModelOptions = (
  { piCatalog, parentSelector }: CandidateModelPickerInput,
  models = piCatalog.piModels,
) =>
  createPiModelOptions({
    models,
    parentModel: findOrUndefined(
      piCatalog.piModels,
      (model) => modelSelector(model) === parentSelector,
    ),
  });

export const supportedPiEfforts = (
  input: CandidateModelPickerInput,
): ReadonlyArray<SubagentEffort> | undefined =>
  findOrUndefined(piModelOptions(input), (option) => option.selector === input.candidate.model)
    ?.supportedEfforts;

export function loadCandidateModelPicker(
  input: CandidateModelPickerInput,
): CandidateModelPickerData {
  const candidate = input.candidate;
  const snapshot = input.piCatalog;
  const optionsFor = (models: ReadonlyArray<ProjectedPiModel>) =>
    retainUnavailableCurrent(candidate.model, piModelOptions(input, models));
  const choices = optionsFor(snapshot.piModels);
  const unsafeModels = Arr.filter(
    snapshot.piModels,
    (model) => !isSafeNativeModelSelector(modelSelector(model)),
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
  const base = { choices, scopedChoices: optionsFor(snapshot.scopedPiModels) };
  return warnings.length > 0 ? { ...base, warning: Arr.join(warnings, " ") } : base;
}
