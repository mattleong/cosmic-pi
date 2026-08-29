import { freezeSnapshot } from "pi-cosmic-core";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import {
  cloneProfileRoute,
  normalizeDeclaredProfileRoute,
  PROFILE_IDS,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteSource,
} from "../profiles/model.ts";
import {
  DEFAULT_SUBAGENT_NESTING_POLICY,
  type DecodedSubagentConfig,
  type SubagentNestingPolicy,
} from "./schema.ts";

export type ResolvedProfileSetSelection =
  | {
      readonly scope: "global" | "project";
      readonly name?: string | undefined;
      readonly invalid: boolean;
    }
  | { readonly scope: "builtin"; readonly invalid: false };

export interface ResolvedSubagentConfig {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectTrusted: boolean;
  readonly globalConfigExists: boolean;
  readonly projectConfigExists: boolean;
  readonly fallbackProfile: ProfileId;
  readonly currentProfileSet: ResolvedProfileSetSelection;
  readonly nesting: SubagentNestingPolicy;
  readonly nestingSource: "builtin" | "global" | "project" | "session";
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface ResolveSubagentConfigInput {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectTrusted: boolean;
  readonly globalConfigExists: boolean;
  readonly projectConfigExists: boolean;
  readonly global: DecodedSubagentConfig;
  readonly project?: DecodedSubagentConfig | undefined;
}

interface ResolvedProfileLayer {
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
}

const builtInProfileLayer = (): ResolvedProfileLayer => {
  // SAFETY: Every fixed profile ID is declared by BUILTIN_PROFILE_ROUTES.
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  // SAFETY: Every fixed profile ID receives one source in the same loop.
  const profileSources = {} as Record<ProfileId, ProfileRouteSource>;
  for (const id of PROFILE_IDS) {
    profiles[id] = cloneProfileRoute(BUILTIN_PROFILE_ROUTES[id]);
    profileSources[id] = "builtin";
  }
  return { profiles, profileSources };
};

const invalidProfileLayer = (
  source: "global-invalid" | "project-invalid",
): ResolvedProfileLayer => {
  // SAFETY: Every fixed profile ID receives one route and source in the same loop.
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  // SAFETY: Every fixed profile ID receives one route and source in the same loop.
  const profileSources = {} as Record<ProfileId, ProfileRouteSource>;
  for (const id of PROFILE_IDS) {
    profiles[id] = { candidates: [] };
    profileSources[id] = source;
  }
  return { profiles, profileSources };
};

const resolveProfileSetLayer = (
  decoded: DecodedSubagentConfig,
  scope: "global" | "project",
  lower: ResolvedProfileLayer,
): ResolvedProfileLayer => {
  const defaultName = decoded.file.defaultProfileSet;
  if (decoded.invalidDefaultProfileSet)
    return invalidProfileLayer(scope === "project" ? "project-invalid" : "global-invalid");
  if (defaultName === undefined) return lower;
  const profileSets = decoded.file.profileSets;
  const profileSet =
    profileSets && Object.prototype.hasOwnProperty.call(profileSets, defaultName)
      ? profileSets[defaultName]
      : undefined;
  if (!profileSet)
    return invalidProfileLayer(scope === "project" ? "project-invalid" : "global-invalid");
  const invalidRoutes = decoded.invalidProfileSetRoutes[defaultName] ?? [];
  // SAFETY: Every fixed profile ID receives one route and source in the same loop.
  const profiles = {} as Record<ProfileId, ProfileRoute>;
  // SAFETY: Every fixed profile ID receives one route and source in the same loop.
  const profileSources = {} as Record<ProfileId, ProfileRouteSource>;
  for (const id of PROFILE_IDS) {
    if (invalidRoutes.includes(id)) {
      profiles[id] = { candidates: [] };
      profileSources[id] = scope === "project" ? "project-invalid" : "global-invalid";
      continue;
    }
    const declaration = profileSet.profiles?.[id];
    if (declaration === undefined) {
      profiles[id] = cloneProfileRoute(lower.profiles[id]);
      profileSources[id] = lower.profileSources[id];
    } else {
      profiles[id] = normalizeDeclaredProfileRoute(declaration);
      profileSources[id] = scope;
    }
  }
  return { profiles, profileSources };
};

const selectedSet = (
  global: DecodedSubagentConfig,
  project: DecodedSubagentConfig | undefined,
): ResolvedProfileSetSelection => {
  if (project && (project.file.defaultProfileSet !== undefined || project.invalidDefaultProfileSet))
    return {
      scope: "project",
      ...(project.file.defaultProfileSet !== undefined && {
        name: project.file.defaultProfileSet,
      }),
      invalid: project.invalidDefaultProfileSet,
    };
  if (global.file.defaultProfileSet !== undefined || global.invalidDefaultProfileSet)
    return {
      scope: "global",
      ...(global.file.defaultProfileSet !== undefined && { name: global.file.defaultProfileSet }),
      invalid: global.invalidDefaultProfileSet,
    };
  return { scope: "builtin", invalid: false };
};

/** Project routes in its selected set replace the selected global-set route; missing routes inherit. */
export function resolveSubagentConfig(input: ResolveSubagentConfigInput): ResolvedSubagentConfig {
  const project = input.projectTrusted ? input.project : undefined;
  const builtin = builtInProfileLayer();
  const global = resolveProfileSetLayer(input.global, "global", builtin);
  const effective = project ? resolveProfileSetLayer(project, "project", global) : global;
  const nesting =
    project?.file.nesting ?? input.global.file.nesting ?? DEFAULT_SUBAGENT_NESTING_POLICY;
  const nestingSource = project?.file.nesting
    ? ("project" as const)
    : input.global.file.nesting
      ? ("global" as const)
      : ("builtin" as const);
  return freezeSnapshot({
    globalConfigPath: input.globalConfigPath,
    projectConfigPath: input.projectConfigPath,
    projectTrusted: input.projectTrusted,
    globalConfigExists: input.globalConfigExists,
    projectConfigExists: input.projectTrusted && input.projectConfigExists,
    fallbackProfile: "generalist",
    currentProfileSet: selectedSet(input.global, project),
    nesting: { ...nesting },
    nestingSource,
    profiles: effective.profiles,
    profileSources: effective.profileSources,
    diagnostics: [...input.global.diagnostics, ...(project?.diagnostics ?? [])],
  });
}
