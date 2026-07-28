import { freezeSnapshot } from "pi-cosmic-core";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import {
  PROFILE_IDS,
  type ModelPolicySelector,
  type ProfileId,
  type ProfileRoute,
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

const cloneRoute = (route: ProfileRoute): ProfileRoute => ({
  fallback: route.fallback,
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

/**
 * Merge semantics are intentionally policy-safe: project denies and discouragements are additive,
 * while a project route atomically replaces the matching global route. Built-ins fill only routes
 * absent from both documents. A trusted-project route that is declared but undecodable fails
 * closed for that profile (no candidates, `fail` fallback) instead of silently reopening the
 * global or built-in route it was meant to replace; sibling routes and additive policy are
 * unaffected. A malformed global route with no project override behaves like an absent route and
 * falls back to the neutral built-in.
 */
export function resolveSubagentConfig(input: ResolveSubagentConfigInput): ResolvedSubagentConfig {
  const project = input.projectTrusted ? input.project : undefined;
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  for (const id of PROFILE_IDS) {
    profiles[id] = project?.invalidProfileRoutes.includes(id)
      ? { candidates: [], fallback: "fail" }
      : cloneRoute(
          project?.file.profiles?.[id] ??
            input.global.file.profiles?.[id] ??
            BUILTIN_PROFILE_ROUTES[id],
        );
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
  // A bare Pi policy selector intentionally applies to that model ID across providers.
  if (
    backend === "pi" &&
    !policyModel.includes("/") &&
    selectedModel.slice(selectedModel.lastIndexOf("/") + 1) === policyModel
  )
    return true;
  // Claude aliases and versioned IDs must not bypass a deny for the same model family.
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
