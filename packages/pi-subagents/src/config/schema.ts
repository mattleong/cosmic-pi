import { flow } from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import {
  isCustomAgentName,
  MAX_CUSTOM_AGENT_DESCRIPTION_CHARS,
  MAX_CUSTOM_AGENT_INSTRUCTIONS_BYTES,
  MAX_CUSTOM_AGENT_TOOL_NAME_CHARS,
  MAX_CUSTOM_AGENT_TOOL_NAMES,
  MAX_CUSTOM_AGENTS,
  type CustomAgentDefinition,
} from "../profiles/agents.ts";
import {
  cloneProfileCandidates,
  MAX_PROFILE_CANDIDATES,
  PROFILE_CANDIDATE_CONTEXTS,
  PROFILE_CANDIDATE_EFFORTS,
  PROFILE_CANDIDATE_RUNTIMES,
  PROFILE_CANDIDATE_WRITE_INTENTS,
  PROFILE_IDS,
  profileCandidateValidationIssues,
  type DeclaredProfileRoute,
  type ProfileCandidate,
  type ProfileId,
  type ProfileRoute,
} from "../profiles/model.ts";

export const SUBAGENT_CONFIG_BASENAME = "pi-subagents.json";
export const SUBAGENT_CONFIG_VERSION = 6;
export const MAX_PROFILE_SETS = 32;

export const WRITER_WORKSPACE_MODES = ["worktree", "shared-checkout"] as const;
export type WriterWorkspaceMode = (typeof WRITER_WORKSPACE_MODES)[number];
export const DEFAULT_WRITER_WORKSPACE_MODE: WriterWorkspaceMode = "shared-checkout";
export const WriterWorkspaceModeSchema = Schema.Literals(WRITER_WORKSPACE_MODES);

export const DELEGATION_MODES = ["normal", "encouraged", "orchestration"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];
export const DEFAULT_DELEGATION_MODE: DelegationMode = "normal";
export const DelegationModeSchema = Schema.Literals(DELEGATION_MODES);

export const MAX_WORKSPACE_SETUP_ARGUMENTS = 64;
export const MAX_WORKSPACE_SETUP_ARGUMENT_CHARS = 4_096;
export const DEFAULT_WORKSPACE_SETUP_TIMEOUT_SECONDS = 600;
export const MAX_WORKSPACE_SETUP_TIMEOUT_SECONDS = 3_600;
/** A trusted project's command that installs dependencies in isolated writer and test trees. */
export const WorkspaceSetupSchema = Schema.Struct({
  command: Schema.Array(
    Schema.String.check(Schema.isBetweenLength(1, MAX_WORKSPACE_SETUP_ARGUMENT_CHARS)),
  ).check(Schema.isBetweenLength(1, MAX_WORKSPACE_SETUP_ARGUMENTS)),
  timeoutSeconds: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_WORKSPACE_SETUP_TIMEOUT_SECONDS),
    ),
  ),
});
export type WorkspaceSetup = typeof WorkspaceSetupSchema.Type;

export const DEFAULT_WORKSPACE_VERIFY_TIMEOUT_SECONDS = 600;
/** A trusted project's command that checks an isolated writer's tree before its changes apply. */
export const WorkspaceVerifySchema = Schema.Struct({
  command: Schema.Array(
    Schema.String.check(
      Schema.isBetweenLength(1, MAX_WORKSPACE_SETUP_ARGUMENT_CHARS),
      Schema.isPattern(/\S/u),
    ),
  ).check(Schema.isBetweenLength(1, MAX_WORKSPACE_SETUP_ARGUMENTS)),
  timeoutSeconds: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_WORKSPACE_SETUP_TIMEOUT_SECONDS),
    ),
  ),
});
export type WorkspaceVerify = typeof WorkspaceVerifySchema.Type;

export const MAX_WORKSPACE_INCLUDE_PATTERNS = 64;
export const MAX_WORKSPACE_INCLUDE_PATTERN_CHARS = 1_024;
/**
 * A trusted project's gitignore-syntax patterns naming untracked local files, such as `.env`,
 * that isolated writer and test trees receive copies of. Git matches them; one pattern per line,
 * so no pattern may hold a control character.
 */
export const WorkspaceIncludeSchema = Schema.Array(
  Schema.String.check(
    Schema.isBetweenLength(1, MAX_WORKSPACE_INCLUDE_PATTERN_CHARS),
    Schema.isPattern(/\S/u),
    Schema.isPattern(/^\P{Cc}*$/u),
  ),
).check(Schema.isMaxLength(MAX_WORKSPACE_INCLUDE_PATTERNS));
export type WorkspaceInclude = typeof WorkspaceIncludeSchema.Type;

export const MIN_DIRECT_CHILDREN = 1;
export const MAX_DIRECT_CHILDREN = 32;
/** Optional cap, in US dollars, on what one session's subagents may spend before new starts stop. */
export const SessionSpendLimitSchema = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(100_000),
);

export const MIN_ACTIVE_RUNS = 1;
export const MAX_ACTIVE_RUNS = 64;
export const DEFAULT_MAX_ACTIVE_RUNS = 16;
export const MIN_SUBAGENT_DEPTH = 0;
export const MAX_SUBAGENT_DEPTH = 8;

const PROFILE_SET_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9])?$/u;

export const isProfileSetName = (value: string): boolean => PROFILE_SET_NAME_PATTERN.test(value);

export const normalizeProfileSetName = (value: string): string | undefined => {
  const normalized = value.trim();
  return isProfileSetName(normalized) ? normalized : undefined;
};

export interface SubagentProfileSet {
  readonly profiles: Partial<Readonly<Record<ProfileId, DeclaredProfileRoute>>>;
}

export interface SubagentConfigFile {
  readonly version?: number | undefined;
  readonly defaultProfileSet?: string | undefined;
  readonly profileSets?: Readonly<Record<string, SubagentProfileSet>> | undefined;
  readonly nesting?: SubagentNestingPolicy | undefined;
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
  readonly delegation?: DelegationMode | undefined;
  readonly workspaceSetup?: WorkspaceSetup | undefined;
  readonly workspaceVerify?: WorkspaceVerify | undefined;
  readonly workspaceInclude?: WorkspaceInclude | undefined;
  readonly sessionSpendLimit?: number | undefined;
  readonly agents?: Readonly<Record<string, CustomAgentDefinition>> | undefined;
}

export interface DecodedSubagentConfig {
  readonly file: SubagentConfigFile;
  readonly diagnostics: ReadonlyArray<string>;
  readonly invalidProfileSetRoutes: Readonly<Record<string, ReadonlyArray<ProfileId>>>;
  readonly invalidProfileSets: ReadonlyArray<string>;
  readonly invalidDefaultProfileSet: boolean;
  /** Agent entries with a valid name that failed to decode; they fail closed. */
  readonly invalidAgents: ReadonlyArray<string>;
  /** The document's `agents` value is not an object of at most 32 entries. */
  readonly invalidAgentsContainer: boolean;
  readonly unsupportedVersion: boolean;
}

export const SubagentNestingSchema = Schema.Struct({
  maxDirectChildren: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(MIN_DIRECT_CHILDREN),
    Schema.isLessThanOrEqualTo(MAX_DIRECT_CHILDREN),
  ),
  maxDepth: Schema.Finite.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(MIN_SUBAGENT_DEPTH),
    Schema.isLessThanOrEqualTo(MAX_SUBAGENT_DEPTH),
  ),
  /** Active subagent processes allowed at once across the whole tree. */
  maxActiveRuns: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(MIN_ACTIVE_RUNS),
      Schema.isLessThanOrEqualTo(MAX_ACTIVE_RUNS),
    ),
  ),
});
export type SubagentNestingPolicy = typeof SubagentNestingSchema.Type;

export const DEFAULT_SUBAGENT_NESTING_POLICY: SubagentNestingPolicy = Object.freeze({
  maxDirectChildren: 12,
  maxDepth: 3,
  maxActiveRuns: DEFAULT_MAX_ACTIVE_RUNS,
});

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
type UnknownRecord = typeof UnknownRecordSchema.Type;
/** A not-yet-decoded value read from a decoded document record. */
type FieldValue = UnknownRecord[string];
const UnknownListSchema = Schema.Array(Schema.Unknown);
type UnknownList = typeof UnknownListSchema.Type;
const decodeUnknownRecord = decodeUnknownOrUndefined(UnknownRecordSchema);
const decodeUnknownList = decodeUnknownOrUndefined(UnknownListSchema);
const EXACT_FIELDS = { onExcessProperty: "error" } as const;

const nullPrototypeRecord = <Value>() => {
  const record: Record<string, Value> = {};
  Object.setPrototypeOf(record, null);
  return record;
};

export const decodeSubagentNesting = flow(
  decodeUnknownOrUndefined(SubagentNestingSchema, EXACT_FIELDS),
  (nesting): SubagentNestingPolicy | undefined => nesting && Object.freeze({ ...nesting }),
);

const hasValidCandidatePolicy = Schema.makeFilter((candidate: ProfileCandidate) =>
  profileCandidateValidationIssues(candidate).length === 0
    ? true
    : "Profile candidate violates cross-field policy.",
);

const ProfileCandidateSchema = Schema.Struct({
  runtime: Schema.Literals(PROFILE_CANDIDATE_RUNTIMES),
  model: Schema.String,
  effort: Schema.Literals(PROFILE_CANDIDATE_EFFORTS),
  context: Schema.Literals(PROFILE_CANDIDATE_CONTEXTS),
  writeIntent: Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS),
  openaiFastMode: Schema.optional(Schema.Boolean),
}).check(hasValidCandidatePolicy);
export const ProfileRouteSchema = Schema.Struct({
  candidates: Schema.Array(ProfileCandidateSchema).check(
    Schema.isMaxLength(MAX_PROFILE_CANDIDATES),
  ),
});

export const decodeDeclaredProfileCandidate = flow(
  decodeUnknownOrUndefined(ProfileCandidateSchema, EXACT_FIELDS),
  (candidate): ProfileCandidate | undefined => candidate,
);

export const decodeProfileRoute = flow(
  decodeUnknownOrUndefined(ProfileRouteSchema, EXACT_FIELDS),
  (route): ProfileRoute | undefined =>
    route && { candidates: cloneProfileCandidates(route.candidates) },
);

const routeFromList = (
  list: UnknownList,
  path: string,
  diagnostics: string[],
): DeclaredProfileRoute | undefined => {
  if (!(list.length > 0 && list.length <= MAX_PROFILE_CANDIDATES)) {
    diagnostics.push(
      list.length > MAX_PROFILE_CANDIDATES ? `${path}[${MAX_PROFILE_CANDIDATES}+]` : path,
    );
    return undefined;
  }
  const candidates = list.map((input, index) => {
    const candidate = decodeDeclaredProfileCandidate(input);
    if (!candidate) diagnostics.push(`${path}[${index}]`);
    return candidate;
  });
  return candidates.every(Predicate.isNotUndefined) ? candidates : undefined;
};

const decodeDeclaredRoute = (
  value: FieldValue,
  path: string,
  diagnostics: string[],
): DeclaredProfileRoute | undefined => {
  if (value === "disabled") return "disabled";
  const list = decodeUnknownList(value);
  if (list) return routeFromList(list, path, diagnostics);
  const candidate = decodeDeclaredProfileCandidate(value);
  if (!candidate) diagnostics.push(path);
  return candidate;
};

export const decodeDeclaredProfileRoute = (value: FieldValue): DeclaredProfileRoute | undefined =>
  decodeDeclaredRoute(value, "route", []);

const hasOnlyKeys = (record: UnknownRecord, allowed: ReadonlySet<string>): boolean =>
  Object.keys(record).every((key) => allowed.has(key));

interface DecodedProfiles {
  readonly profiles: Partial<Record<ProfileId, DeclaredProfileRoute>>;
  readonly invalidRoutes: ReadonlyArray<ProfileId>;
}

const PROFILE_KEYS: ReadonlySet<string> = new Set(PROFILE_IDS);

const profilesFromRecord = (
  record: UnknownRecord,
  path: string,
  diagnostics: string[],
): DecodedProfiles => {
  const profiles: Partial<Record<ProfileId, DeclaredProfileRoute>> = {};
  const invalidRoutes: ProfileId[] = [];
  for (const id of PROFILE_IDS) {
    if (!Object.hasOwn(record, id)) continue;
    const route = decodeDeclaredRoute(record[id], `${path}.${id}`, diagnostics);
    if (route === undefined) invalidRoutes.push(id);
    else profiles[id] = route;
  }
  if (!hasOnlyKeys(record, PROFILE_KEYS)) diagnostics.push(`${path}.<unknown>`);
  return { profiles, invalidRoutes };
};

const ProfileSetInputSchema = Schema.Struct({ profiles: UnknownRecordSchema });
const decodeProfileSetInput = decodeUnknownOrUndefined(ProfileSetInputSchema, EXACT_FIELDS);
const SET_KEYS: ReadonlySet<string> = new Set(["profiles"]);

interface DecodedBody {
  readonly file: SubagentConfigFile;
  readonly invalidProfileSetRoutes: Readonly<Record<string, ReadonlyArray<ProfileId>>>;
  readonly invalidProfileSets: ReadonlyArray<string>;
  readonly invalidDefaultProfileSet: boolean;
  readonly invalidAgents: ReadonlyArray<string>;
  readonly invalidAgentsContainer: boolean;
}

const EMPTY_BODY: DecodedBody = Object.freeze({
  file: Object.freeze({}),
  invalidProfileSetRoutes: Object.freeze({}),
  invalidProfileSets: Object.freeze([]),
  invalidDefaultProfileSet: false,
  invalidAgents: Object.freeze([]),
  invalidAgentsContainer: false,
});

const decodeProfileSet = (
  value: FieldValue,
  setPath: string,
  diagnostics: string[],
): DecodedProfiles | undefined => {
  const set = decodeProfileSetInput(value);
  if (set) return profilesFromRecord(set.profiles, `${setPath}.profiles`, diagnostics);
  // Distinguish a malformed profiles container from a malformed set for repair diagnostics.
  const fields = decodeUnknownRecord(value);
  diagnostics.push(fields && hasOnlyKeys(fields, SET_KEYS) ? `${setPath}.profiles` : setPath);
  return undefined;
};

const decodeProfileSets = (
  value: FieldValue,
  path: string,
  diagnostics: string[],
): Pick<DecodedBody, "invalidProfileSetRoutes" | "invalidProfileSets"> & {
  readonly sets: Record<string, SubagentProfileSet>;
} => {
  const record = decodeUnknownRecord(value);
  const names = record && Object.keys(record);
  if (!record || !names || names.length > MAX_PROFILE_SETS) {
    diagnostics.push(
      names && names.length > MAX_PROFILE_SETS ? `${path}[${MAX_PROFILE_SETS}+]` : path,
    );
    return { sets: {}, invalidProfileSetRoutes: {}, invalidProfileSets: [] };
  }
  const sets = nullPrototypeRecord<SubagentProfileSet>();
  const invalidProfileSetRoutes: Record<string, ReadonlyArray<ProfileId>> = {};
  const invalidProfileSets: string[] = [];
  // Set names may be private, so diagnostics identify sets by position.
  names.forEach((name, index) => {
    const setPath = `${path}[${index}]`;
    if (!isProfileSetName(name)) {
      diagnostics.push(`${setPath}.name`);
      return;
    }
    const decoded = decodeProfileSet(record[name], setPath, diagnostics);
    if (!decoded) {
      invalidProfileSets.push(name);
      return;
    }
    sets[name] = { profiles: decoded.profiles };
    if (decoded.invalidRoutes.length > 0) invalidProfileSetRoutes[name] = decoded.invalidRoutes;
  });
  return { sets, invalidProfileSetRoutes, invalidProfileSets };
};

const utf8 = new TextEncoder();
const nonblankText = (maxLength: number) =>
  Schema.String.check(Schema.isBetweenLength(1, maxLength), Schema.isPattern(/\S/u));
// Tool names reach the Pi child's comma-separated tool argument, as the root's own names do.
const CustomAgentToolNamesSchema = Schema.Array(
  Schema.String.check(
    Schema.isBetweenLength(1, MAX_CUSTOM_AGENT_TOOL_NAME_CHARS),
    Schema.isPattern(/^[^\s,\p{Cc}](?:[^,\p{Cc}]*[^\s,\p{Cc}])?$/u),
  ),
).check(Schema.isMaxLength(MAX_CUSTOM_AGENT_TOOL_NAMES));
const CustomAgentSchema = Schema.Struct({
  description: nonblankText(MAX_CUSTOM_AGENT_DESCRIPTION_CHARS),
  instructions: Schema.String.check(
    Schema.isPattern(/\S/u),
    Schema.makeFilter((instructions: string) =>
      utf8.encode(instructions).length <= MAX_CUSTOM_AGENT_INSTRUCTIONS_BYTES
        ? true
        : "Agent instructions exceed 16 KiB.",
    ),
  ),
  profile: Schema.optionalKey(Schema.Literals(PROFILE_IDS)),
  effort: Schema.optionalKey(Schema.Literals(SUBAGENT_EFFORTS)),
  context: Schema.optionalKey(Schema.Literals(PROFILE_CANDIDATE_CONTEXTS)),
  writeIntent: Schema.optionalKey(Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS)),
  isolation: Schema.optionalKey(WriterWorkspaceModeSchema),
  tools: Schema.optionalKey(
    Schema.Struct({
      allow: Schema.optionalKey(CustomAgentToolNamesSchema),
      deny: Schema.optionalKey(CustomAgentToolNamesSchema),
    }),
  ),
});
export const decodeCustomAgentDefinition = flow(
  decodeUnknownOrUndefined(CustomAgentSchema, EXACT_FIELDS),
  (agent): CustomAgentDefinition | undefined => agent,
);

interface DecodedCustomAgents {
  readonly agents: Record<string, CustomAgentDefinition>;
  readonly invalidAgents: ReadonlyArray<string>;
  readonly containerInvalid: boolean;
}

const decodeCustomAgents = (
  value: FieldValue,
  path: string,
  diagnostics: string[],
): DecodedCustomAgents => {
  const record = decodeUnknownRecord(value);
  const names = record && Object.keys(record);
  if (!record || !names || names.length > MAX_CUSTOM_AGENTS) {
    diagnostics.push(
      names && names.length > MAX_CUSTOM_AGENTS ? `${path}[${MAX_CUSTOM_AGENTS}+]` : path,
    );
    return { agents: {}, invalidAgents: [], containerInvalid: true };
  }
  const agents = nullPrototypeRecord<CustomAgentDefinition>();
  const invalidAgents: string[] = [];
  // Like set names, agent names are identified by position in diagnostics.
  names.forEach((name, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isCustomAgentName(name)) {
      diagnostics.push(`${entryPath}.name`);
      return;
    }
    const agent = decodeCustomAgentDefinition(record[name]);
    if (agent) agents[name] = agent;
    else {
      diagnostics.push(entryPath);
      invalidAgents.push(name);
    }
  });
  return { agents, invalidAgents, containerInvalid: false };
};

export const isSupportedConfigVersion = Schema.is(Schema.Literal(SUBAGENT_CONFIG_VERSION));

const ROOT_KEYS: ReadonlySet<string> = new Set([
  "version",
  "defaultProfileSet",
  "profileSets",
  "nesting",
  "writerWorkspaceMode",
  "delegation",
  "workspaceSetup",
  "workspaceVerify",
  "workspaceInclude",
  "sessionSpendLimit",
  "agents",
]);

const decodeRootField = <S extends Schema.ConstraintDecoder<unknown>>(
  root: UnknownRecord,
  key: string,
  scope: string,
  diagnostics: string[],
  schema: S,
  options?: typeof EXACT_FIELDS,
): S["Type"] | undefined => {
  if (!Object.hasOwn(root, key)) return undefined;
  const decoded = decodeUnknownOrUndefined(schema, options)(root[key]);
  if (decoded === undefined) diagnostics.push(`${scope}.${key}`);
  return decoded;
};

const decodeDefaultProfileSet = (root: UnknownRecord, scope: string, diagnostics: string[]) => {
  const present = Object.hasOwn(root, "defaultProfileSet");
  const value = root.defaultProfileSet;
  const defaultProfileSet =
    present && Predicate.isString(value) && isProfileSetName(value) ? value : undefined;
  const invalidDefaultProfileSet = present && defaultProfileSet === undefined;
  if (invalidDefaultProfileSet) diagnostics.push(`${scope}.defaultProfileSet`);
  return { defaultProfileSet, invalidDefaultProfileSet };
};

// Setup and verification commands are repository-specific, so only a project document may
// declare one.
const decodeWorkspaceCommand = (
  root: UnknownRecord,
  key: "workspaceSetup" | "workspaceVerify",
  schema: typeof WorkspaceSetupSchema | typeof WorkspaceVerifySchema,
  scope: string,
  diagnostics: string[],
): WorkspaceSetup | WorkspaceVerify | undefined => {
  if (!Object.hasOwn(root, key)) return undefined;
  const command =
    scope === "project" ? decodeUnknownOrUndefined(schema, EXACT_FIELDS)(root[key]) : undefined;
  if (command === undefined) {
    diagnostics.push(`${scope}.${key}`);
    return undefined;
  }
  return Object.freeze({ ...command, command: Object.freeze([...command.command]) });
};

// Like setup commands, included files are repository-specific; an empty list includes nothing.
const decodeWorkspaceInclude = (
  root: UnknownRecord,
  scope: string,
  diagnostics: string[],
): WorkspaceInclude | undefined => {
  if (!Object.hasOwn(root, "workspaceInclude")) return undefined;
  const patterns =
    scope === "project"
      ? decodeUnknownOrUndefined(WorkspaceIncludeSchema)(root.workspaceInclude)
      : undefined;
  if (patterns === undefined) diagnostics.push(`${scope}.workspaceInclude`);
  return patterns && patterns.length > 0 ? Object.freeze([...patterns]) : undefined;
};

const decodeCurrentBody = (
  root: UnknownRecord,
  scope: string,
  diagnostics: string[],
): DecodedBody => {
  const writerWorkspaceMode = decodeRootField(
    root,
    "writerWorkspaceMode",
    scope,
    diagnostics,
    WriterWorkspaceModeSchema,
  );
  const delegation = decodeRootField(root, "delegation", scope, diagnostics, DelegationModeSchema);
  const workspaceSetup = decodeWorkspaceCommand(
    root,
    "workspaceSetup",
    WorkspaceSetupSchema,
    scope,
    diagnostics,
  );
  const workspaceVerify = decodeWorkspaceCommand(
    root,
    "workspaceVerify",
    WorkspaceVerifySchema,
    scope,
    diagnostics,
  );
  const workspaceInclude = decodeWorkspaceInclude(root, scope, diagnostics);
  const sessionSpendLimit = decodeRootField(
    root,
    "sessionSpendLimit",
    scope,
    diagnostics,
    SessionSpendLimitSchema,
  );
  const decoded = Object.hasOwn(root, "profileSets")
    ? decodeProfileSets(root.profileSets, `${scope}.profileSets`, diagnostics)
    : undefined;
  const agents = Object.hasOwn(root, "agents")
    ? decodeCustomAgents(root.agents, `${scope}.agents`, diagnostics)
    : undefined;
  const { defaultProfileSet, invalidDefaultProfileSet } = decodeDefaultProfileSet(
    root,
    scope,
    diagnostics,
  );
  return {
    file: {
      ...(decoded && Object.keys(decoded.sets).length > 0 && { profileSets: decoded.sets }),
      ...(defaultProfileSet !== undefined && { defaultProfileSet }),
      ...(writerWorkspaceMode !== undefined && { writerWorkspaceMode }),
      ...(delegation !== undefined && { delegation }),
      ...(workspaceSetup !== undefined && { workspaceSetup }),
      ...(workspaceVerify !== undefined && { workspaceVerify }),
      ...(workspaceInclude !== undefined && { workspaceInclude }),
      ...(sessionSpendLimit !== undefined && { sessionSpendLimit }),
      ...(agents && Object.keys(agents.agents).length > 0 && { agents: agents.agents }),
    },
    invalidProfileSetRoutes: decoded?.invalidProfileSetRoutes ?? {},
    invalidProfileSets: decoded?.invalidProfileSets ?? [],
    invalidDefaultProfileSet,
    invalidAgents: agents?.invalidAgents ?? [],
    invalidAgentsContainer: agents?.containerInvalid ?? false,
  };
};

const declaresMissingDefault = (file: SubagentConfigFile): boolean => {
  const defaultName = file.defaultProfileSet;
  return (
    defaultName !== undefined && !(file.profileSets && Object.hasOwn(file.profileSets, defaultName))
  );
};

const decodeConfigRoot = (
  decodedRoot: UnknownRecord | undefined,
  scope: string,
): DecodedSubagentConfig => {
  const diagnostics: string[] = [];
  const root: UnknownRecord = decodedRoot ?? {};
  if (!decodedRoot) diagnostics.push(scope);
  const version = isSupportedConfigVersion(root.version) ? root.version : undefined;
  if (!hasOnlyKeys(root, ROOT_KEYS)) diagnostics.push(`${scope}.<unknown>`);

  const body = version === undefined ? EMPTY_BODY : decodeCurrentBody(root, scope, diagnostics);
  const nesting =
    version === undefined
      ? undefined
      : decodeRootField(root, "nesting", scope, diagnostics, SubagentNestingSchema, EXACT_FIELDS);
  const file: SubagentConfigFile = {
    ...(version !== undefined && { version }),
    ...body.file,
    ...(nesting !== undefined && { nesting: Object.freeze({ ...nesting }) }),
  };

  const missingDefault = declaresMissingDefault(file);
  if (missingDefault) diagnostics.push(`${scope}.defaultProfileSet`);
  const unsupportedVersion = version === undefined;
  if (unsupportedVersion) diagnostics.push(`${scope}.version`);

  return {
    file,
    diagnostics: [...new Set(diagnostics)],
    invalidProfileSetRoutes: Object.assign(
      nullPrototypeRecord<ReadonlyArray<ProfileId>>(),
      body.invalidProfileSetRoutes,
    ),
    invalidProfileSets: body.invalidProfileSets,
    invalidDefaultProfileSet: body.invalidDefaultProfileSet || missingDefault,
    invalidAgents: body.invalidAgents,
    invalidAgentsContainer: body.invalidAgentsContainer,
    unsupportedVersion,
  };
};

export const subagentConfigDecoder = (scope: string) =>
  flow(decodeUnknownRecord, (root) => decodeConfigRoot(root, scope));

export const decodeSubagentConfig = subagentConfigDecoder("config");
