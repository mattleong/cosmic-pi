import { freezeSnapshot } from "pi-cosmic-core";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import {
  cloneProfileRoute,
  mapProfileIds,
  normalizeDeclaredProfileRoute,
  PROFILE_IDS,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteSource,
} from "../profiles/model.ts";
import {
  DEFAULT_SUBAGENT_FEATURE_TOGGLES,
  DEFAULT_SUBAGENT_NESTING_POLICY,
  DEFAULT_WRITER_WORKSPACE_MODE,
  type WriterWorkspaceMode,
  type DecodedSubagentConfig,
  type SubagentFeatureToggle,
  type SubagentFeatureToggles,
  type SubagentNestingPolicy,
} from "./schema.ts";

export type ResolvedProfileSetSelection =
  | { readonly scope: "builtin" }
  | {
      readonly scope: "global" | "project";
      readonly name?: string | undefined;
      /** Retained only for a fail-closed loaded default whose name or target is invalid. */
      readonly invalid?: boolean | undefined;
    };

/** Every feature switch resolved to a required boolean; `/reload` picks up saved changes. */
export interface ResolvedSubagentConfig extends SubagentFeatureToggles {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly fallbackProfile: ProfileId;
  readonly currentProfileSet: ResolvedProfileSetSelection;
  readonly nesting: SubagentNestingPolicy;
  readonly writerWorkspaceMode: WriterWorkspaceMode;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface ResolveSubagentConfigInput {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectTrusted: boolean;
  readonly global: DecodedSubagentConfig;
  readonly project?: DecodedSubagentConfig | undefined;
}

export type NamedProfileSetScope = "global" | "project";
export type ResolvedNamedProfileSetStatus =
  | "resolved"
  | "invalid-routes"
  | "missing"
  | "structurally-invalid";

export interface ResolvedNamedProfileSet {
  readonly origin: {
    readonly scope: NamedProfileSetScope;
    readonly name: string;
  };
  readonly status: ResolvedNamedProfileSetStatus;
  readonly invalidProfiles: ReadonlyArray<ProfileId>;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
}

export interface ResolveNamedProfileSetInput {
  readonly scope: NamedProfileSetScope;
  readonly name: string;
  readonly global: DecodedSubagentConfig;
  readonly project?: DecodedSubagentConfig | undefined;
}

interface ResolvedProfileLayer {
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
}

interface ResolvedNamedProfileLayer {
  readonly layer: ResolvedProfileLayer;
  readonly status: ResolvedNamedProfileSetStatus;
}

const builtInProfileLayer = (): ResolvedProfileLayer => ({
  profiles: mapProfileIds((id) => cloneProfileRoute(BUILTIN_PROFILE_ROUTES[id])),
  profileSources: mapProfileIds(() => "builtin"),
});

const invalidProfileLayer = (
  source: "global-invalid" | "project-invalid",
): ResolvedProfileLayer => ({
  profiles: mapProfileIds(() => ({ candidates: [] })),
  profileSources: mapProfileIds(() => source),
});

const resolveNamedProfileLayer = (
  decoded: DecodedSubagentConfig,
  scope: NamedProfileSetScope,
  name: string,
  lower: ResolvedProfileLayer,
): ResolvedNamedProfileLayer => {
  const invalidSource = `${scope}-invalid` as const;
  if (decoded.invalidProfileSets.includes(name))
    return { layer: invalidProfileLayer(invalidSource), status: "structurally-invalid" };
  const profileSets = decoded.file.profileSets;
  const profileSet =
    profileSets && Object.prototype.hasOwnProperty.call(profileSets, name)
      ? profileSets[name]
      : undefined;
  if (!profileSet) return { layer: invalidProfileLayer(invalidSource), status: "missing" };
  const invalidRoutes = decoded.invalidProfileSetRoutes[name] ?? [];
  const profiles = mapProfileIds((id): ProfileRoute => {
    const declaration = profileSet.profiles[id];
    if (invalidRoutes.includes(id)) return { candidates: [] };
    return declaration === undefined
      ? cloneProfileRoute(lower.profiles[id])
      : normalizeDeclaredProfileRoute(declaration);
  });
  const profileSources = mapProfileIds((id): ProfileRouteSource => {
    if (invalidRoutes.includes(id)) return invalidSource;
    return profileSet.profiles[id] === undefined ? lower.profileSources[id] : scope;
  });
  return {
    layer: { profiles, profileSources },
    status: PROFILE_IDS.some((id) => profileSources[id].endsWith("-invalid"))
      ? "invalid-routes"
      : "resolved",
  };
};

const resolveProfileSetLayer = (
  decoded: DecodedSubagentConfig,
  scope: NamedProfileSetScope,
  lower: ResolvedProfileLayer,
): ResolvedProfileLayer => {
  const defaultName = decoded.file.defaultProfileSet;
  if (decoded.invalidDefaultProfileSet) return invalidProfileLayer(`${scope}-invalid`);
  if (defaultName === undefined) return lower;
  return resolveNamedProfileLayer(decoded, scope, defaultName, lower).layer;
};

/** Resolves one saved set without changing either document's selected default. */
export function resolveNamedProfileSet(
  input: ResolveNamedProfileSetInput,
): ResolvedNamedProfileSet {
  const builtin = builtInProfileLayer();
  const lower =
    input.scope === "project" ? resolveProfileSetLayer(input.global, "global", builtin) : builtin;
  const decoded = input.scope === "global" ? input.global : input.project;
  const resolved = decoded
    ? resolveNamedProfileLayer(decoded, input.scope, input.name, lower)
    : { layer: invalidProfileLayer(`${input.scope}-invalid`), status: "missing" as const };
  return freezeSnapshot({
    origin: { scope: input.scope, name: input.name },
    status: resolved.status,
    invalidProfiles: PROFILE_IDS.filter((id) =>
      resolved.layer.profileSources[id].endsWith("-invalid"),
    ),
    profiles: resolved.layer.profiles,
    profileSources: resolved.layer.profileSources,
  });
}

/** The scope's declared default selection, including a fail-closed invalid default. */
const declaredSelection = (
  scope: NamedProfileSetScope,
  decoded: DecodedSubagentConfig | undefined,
): ResolvedProfileSetSelection | undefined => {
  const name = decoded?.file.defaultProfileSet;
  if (!decoded || (name === undefined && !decoded.invalidDefaultProfileSet)) return undefined;
  return {
    scope,
    ...(name !== undefined && { name }),
    ...(decoded.invalidDefaultProfileSet && { invalid: true }),
  };
};

/** A trusted Project declaration wins over Global; with neither, every feature is enabled. */
const resolveSubagentFeatureToggles = (
  global: DecodedSubagentConfig,
  project?: DecodedSubagentConfig,
): SubagentFeatureToggles => {
  const resolve = (toggle: SubagentFeatureToggle): boolean =>
    project?.file[toggle] ?? global.file[toggle] ?? DEFAULT_SUBAGENT_FEATURE_TOGGLES[toggle];
  return {
    scriptedWorkflows: resolve("scriptedWorkflows"),
  };
};

/** Project routes in its selected set replace the selected global-set route; missing routes inherit. */
export function resolveSubagentConfig(input: ResolveSubagentConfigInput): ResolvedSubagentConfig {
  const project = input.projectTrusted ? input.project : undefined;
  const builtin = builtInProfileLayer();
  const global = resolveProfileSetLayer(input.global, "global", builtin);
  const effective = project ? resolveProfileSetLayer(project, "project", global) : global;
  const nesting =
    project?.file.nesting ?? input.global.file.nesting ?? DEFAULT_SUBAGENT_NESTING_POLICY;
  return freezeSnapshot({
    ...resolveSubagentFeatureToggles(input.global, project),
    globalConfigPath: input.globalConfigPath,
    projectConfigPath: input.projectConfigPath,
    fallbackProfile: "generalist",
    currentProfileSet: declaredSelection("project", project) ??
      declaredSelection("global", input.global) ?? { scope: "builtin" },
    nesting: { ...nesting },
    writerWorkspaceMode:
      project?.file.writerWorkspaceMode ??
      input.global.file.writerWorkspaceMode ??
      DEFAULT_WRITER_WORKSPACE_MODE,
    profiles: effective.profiles,
    profileSources: effective.profileSources,
    diagnostics: [...input.global.diagnostics, ...(project?.diagnostics ?? [])],
  });
}
