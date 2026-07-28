import { freezeSnapshot } from "pi-cosmic-core";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import {
  PROFILE_IDS,
  type DeclaredProfileRoute,
  type ModelPolicySelector,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteSource,
} from "../profiles/model.ts";
import type { SubagentBackend } from "../run/model.ts";
import type { DecodedSubagentConfig } from "./schema.ts";

export interface ResolvedSubagentConfig {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectTrusted: boolean;
  readonly globalConfigExists: boolean;
  readonly projectConfigExists: boolean;
  readonly defaultProfile: ProfileId;
  readonly denied: ReadonlyArray<ModelPolicySelector>;
  readonly discouraged: ReadonlyArray<ModelPolicySelector>;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
  readonly diagnostics: ReadonlyArray<string>;
}

export type ModelPolicy = "allowed" | "discouraged" | "denied";

const selectorKey = (selector: ModelPolicySelector): string =>
  `${selector.backend}\u0000${selector.model.trim().toLowerCase()}`;

const unionSelectors = (
  ...collections: ReadonlyArray<ReadonlyArray<ModelPolicySelector> | undefined>
): ReadonlyArray<ModelPolicySelector> => {
  const seen = new Set<string>();
  const result: ModelPolicySelector[] = [];
  for (const collection of collections) {
    for (const selector of collection ?? []) {
      const key = selectorKey(selector);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ backend: selector.backend, model: selector.model.trim() });
    }
  }
  return result;
};

const normalizeRoute = (route: DeclaredProfileRoute): ProfileRoute => ({
  candidates:
    route === "disabled"
      ? []
      : (Array.isArray(route) ? route : [route]).map((candidate) => ({ ...candidate })),
});

const cloneRoute = (route: ProfileRoute): ProfileRoute => ({
  candidates: route.candidates.map((candidate) => ({ ...candidate })),
});

export interface ResolveSubagentConfigInput {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectTrusted: boolean;
  readonly globalConfigExists: boolean;
  readonly projectConfigExists: boolean;
  readonly global: DecodedSubagentConfig;
  readonly project?: DecodedSubagentConfig | undefined;
}

/** Project routes replace global routes atomically; project policy remains additive. */
export function resolveSubagentConfig(input: ResolveSubagentConfigInput): ResolvedSubagentConfig {
  const project = input.projectTrusted ? input.project : undefined;
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  const profileSources = {} as Record<ProfileId, ProfileRouteSource>;
  for (const id of PROFILE_IDS) {
    if (project?.invalidProfileRoutes.includes(id)) {
      profiles[id] = { candidates: [] };
      profileSources[id] = "project-invalid";
    } else if (project?.file.profiles?.[id] !== undefined) {
      profiles[id] = normalizeRoute(project.file.profiles[id]);
      profileSources[id] = "project";
    } else if (input.global.invalidProfileRoutes.includes(id)) {
      profiles[id] = { candidates: [] };
      profileSources[id] = "global-invalid";
    } else if (input.global.file.profiles?.[id] !== undefined) {
      profiles[id] = normalizeRoute(input.global.file.profiles[id]);
      profileSources[id] = "global";
    } else {
      profiles[id] = cloneRoute(BUILTIN_PROFILE_ROUTES[id]);
      profileSources[id] = "builtin";
    }
  }
  return freezeSnapshot({
    globalConfigPath: input.globalConfigPath,
    projectConfigPath: input.projectConfigPath,
    projectTrusted: input.projectTrusted,
    globalConfigExists: input.globalConfigExists,
    projectConfigExists: input.projectTrusted && input.projectConfigExists,
    defaultProfile:
      project?.file.defaultProfile ?? input.global.file.defaultProfile ?? ("delegate" as const),
    denied: unionSelectors(input.global.file.denied, project?.file.denied),
    discouraged: unionSelectors(input.global.file.discouraged, project?.file.discouraged),
    profiles,
    profileSources,
    diagnostics: [...input.global.diagnostics, ...(project?.diagnostics ?? [])],
  });
}

const selectorMatches = (
  selector: ModelPolicySelector,
  backend: SubagentBackend,
  model: string,
): boolean => {
  if (selector.backend !== backend) return false;
  const policyModel = selector.model.trim().toLowerCase();
  const selectedModel = model.trim().toLowerCase();
  if (policyModel === selectedModel) return true;
  if (
    backend === "pi" &&
    !policyModel.includes("/") &&
    selectedModel.slice(selectedModel.lastIndexOf("/") + 1) === policyModel
  )
    return true;
  if (backend === "claude-cli") {
    for (const alias of ["fable", "sonnet", "opus", "haiku"]) {
      if (
        (policyModel === alias &&
          selectedModel.startsWith("claude") &&
          selectedModel.includes(alias)) ||
        (selectedModel === alias && policyModel.startsWith("claude") && policyModel.includes(alias))
      )
        return true;
    }
    if (
      policyModel.startsWith("claude") &&
      selectedModel.startsWith("claude") &&
      (selectedModel.startsWith(`${policyModel}-`) || policyModel.startsWith(`${selectedModel}-`))
    )
      return true;
  }
  return false;
};

export function modelPolicyFor(
  config: Pick<ResolvedSubagentConfig, "denied" | "discouraged">,
  backend: SubagentBackend,
  model: string,
): ModelPolicy {
  if (config.denied.some((selector) => selectorMatches(selector, backend, model))) return "denied";
  if (config.discouraged.some((selector) => selectorMatches(selector, backend, model)))
    return "discouraged";
  return "allowed";
}
