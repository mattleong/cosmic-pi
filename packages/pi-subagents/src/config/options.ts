import { freezeSnapshot } from "pi-cosmic-core";
import {
  resolveCustomAgents,
  type CustomAgent,
  type InvalidCustomAgent,
} from "../profiles/agents.ts";
import { BUILTIN_PROFILE_ROUTES } from "../profiles/definitions.ts";
import {
  mapProfileIds,
  normalizeDeclaredProfileRoute,
  PROFILE_IDS,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteSource,
} from "../profiles/model.ts";
import {
  DEFAULT_DELEGATION_MODE,
  DEFAULT_SUBAGENT_NESTING_POLICY,
  DEFAULT_WRITER_WORKSPACE_MODE,
  type DelegationMode,
  type WriterWorkspaceMode,
  type WorktreeHook,
  type WorktreeHookEvent,
  type DecodedSubagentConfig,
  type SubagentNestingPolicy,
} from "./schema.ts";

export type ResolvedProfileSetSelection =
  | { readonly scope: "builtin" }
  | {
      readonly scope: "global" | "project";
      readonly name?: string | undefined;
      readonly invalid?: boolean | undefined;
    };

interface ConfiguredWorktreeHook extends WorktreeHook {
  readonly scope: "global" | "project";
}
/** Each event's hooks in run order: global ones first, then a trusted project's. */
type ResolvedWorktreeHooks = Readonly<
  Record<WorktreeHookEvent, ReadonlyArray<ConfiguredWorktreeHook>>
>;

export interface ResolvedSubagentConfig {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly fallbackProfile: ProfileId;
  readonly currentProfileSet: ResolvedProfileSetSelection;
  readonly nesting: SubagentNestingPolicy;
  readonly writerWorkspaceMode: WriterWorkspaceMode;
  readonly delegation: DelegationMode;
  /** Untrusted project documents contribute none. */
  readonly hooks: ResolvedWorktreeHooks;
  readonly sessionSpendLimit?: number | undefined;
  readonly profiles: Readonly<Record<ProfileId, ProfileRoute>>;
  readonly profileSources: Readonly<Record<ProfileId, ProfileRouteSource>>;
  /** Global agents overlaid by trusted-project agents of the same name. */
  readonly agents: ReadonlyArray<CustomAgent>;
  readonly invalidAgents: ReadonlyArray<InvalidCustomAgent>;
  readonly diagnostics: ReadonlyArray<string>;
}

interface ResolveSubagentConfigInput {
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectTrusted: boolean;
  readonly global: DecodedSubagentConfig;
  readonly project?: DecodedSubagentConfig | undefined;
}

type NamedProfileSetScope = "global" | "project";
type ResolvedNamedProfileSetStatus =
  | "resolved"
  | "invalid-routes"
  | "missing"
  | "structurally-invalid";

type ResolvedProfileLayer = Pick<ResolvedSubagentConfig, "profiles" | "profileSources">;

interface ResolvedNamedProfileSet extends ResolvedProfileLayer {
  readonly origin: {
    readonly scope: NamedProfileSetScope;
    readonly name: string;
  };
  readonly status: ResolvedNamedProfileSetStatus;
  readonly invalidProfiles: ReadonlyArray<ProfileId>;
}

interface ResolveNamedProfileSetInput {
  readonly scope: NamedProfileSetScope;
  readonly name: string;
  readonly global: DecodedSubagentConfig;
  readonly project?: DecodedSubagentConfig | undefined;
}

interface ResolvedNamedProfileLayer {
  readonly layer: ResolvedProfileLayer;
  readonly status: ResolvedNamedProfileSetStatus;
}

const BUILTIN_PROFILE_LAYER: ResolvedProfileLayer = {
  profiles: BUILTIN_PROFILE_ROUTES,
  profileSources: mapProfileIds(() => "builtin"),
};

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
    profileSets && Object.hasOwn(profileSets, name) ? profileSets[name] : undefined;
  if (!profileSet) return { layer: invalidProfileLayer(invalidSource), status: "missing" };
  const invalidRoutes = decoded.invalidProfileSetRoutes[name] ?? [];
  const profiles = mapProfileIds((id): ProfileRoute => {
    const declaration = profileSet.profiles[id];
    if (invalidRoutes.includes(id)) return { candidates: [] };
    return declaration === undefined
      ? lower.profiles[id]
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

export function resolveNamedProfileSet(
  input: ResolveNamedProfileSetInput,
): ResolvedNamedProfileSet {
  const lower =
    input.scope === "project"
      ? resolveProfileSetLayer(input.global, "global", BUILTIN_PROFILE_LAYER)
      : BUILTIN_PROFILE_LAYER;
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

const layeredPolicy = (
  project: DecodedSubagentConfig | undefined,
  global: DecodedSubagentConfig,
): Pick<
  ResolvedSubagentConfig,
  "currentProfileSet" | "nesting" | "writerWorkspaceMode" | "delegation"
> => ({
  currentProfileSet: declaredSelection("project", project) ??
    declaredSelection("global", global) ?? { scope: "builtin" },
  nesting: project?.file.nesting ?? global.file.nesting ?? DEFAULT_SUBAGENT_NESTING_POLICY,
  writerWorkspaceMode:
    project?.file.writerWorkspaceMode ??
    global.file.writerWorkspaceMode ??
    DEFAULT_WRITER_WORKSPACE_MODE,
  delegation: project?.file.delegation ?? global.file.delegation ?? DEFAULT_DELEGATION_MODE,
});

const agentLayer = (scope: NamedProfileSetScope, decoded: DecodedSubagentConfig) => ({
  scope,
  agents: decoded.file.agents,
  invalidNames: decoded.invalidAgents,
  containerInvalid: decoded.invalidAgentsContainer,
});

const worktreeHooks = (
  global: DecodedSubagentConfig,
  project: DecodedSubagentConfig | undefined,
): ResolvedWorktreeHooks => {
  const layers = [
    { scope: "global" as const, hooks: global.file.hooks },
    { scope: "project" as const, hooks: project?.file.hooks },
  ];
  const forEvent = (event: WorktreeHookEvent) =>
    layers.flatMap(({ scope, hooks }) =>
      (hooks?.[event] ?? []).map((hook): ConfiguredWorktreeHook => Object.assign({ scope }, hook)),
    );
  return { WorktreeCreate: forEvent("WorktreeCreate"), WorktreeRemove: forEvent("WorktreeRemove") };
};

export function resolveSubagentConfig(input: ResolveSubagentConfigInput): ResolvedSubagentConfig {
  const project = input.projectTrusted ? input.project : undefined;
  const global = resolveProfileSetLayer(input.global, "global", BUILTIN_PROFILE_LAYER);
  const effective = project ? resolveProfileSetLayer(project, "project", global) : global;
  const policy = layeredPolicy(project, input.global);
  const agents = resolveCustomAgents([
    agentLayer("global", input.global),
    ...(project ? [agentLayer("project", project)] : []),
  ]);
  return freezeSnapshot({
    globalConfigPath: input.globalConfigPath,
    projectConfigPath: input.projectConfigPath,
    fallbackProfile: "generalist",
    currentProfileSet: policy.currentProfileSet,
    nesting: policy.nesting,
    writerWorkspaceMode: policy.writerWorkspaceMode,
    delegation: policy.delegation,
    hooks: worktreeHooks(input.global, project),
    ...((project?.file.sessionSpendLimit ?? input.global.file.sessionSpendLimit) !== undefined && {
      sessionSpendLimit: project?.file.sessionSpendLimit ?? input.global.file.sessionSpendLimit,
    }),
    profiles: effective.profiles,
    profileSources: effective.profileSources,
    agents: agents.agents,
    invalidAgents: agents.invalidAgents,
    diagnostics: [...input.global.diagnostics, ...(project?.diagnostics ?? [])],
  });
}
