import { flow } from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { clipText, decodeUnknownOrUndefined } from "pi-cosmic-core";
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
export const isWriterWorkspaceMode = Schema.is(WriterWorkspaceModeSchema);

export const DELEGATION_MODES = ["normal", "encouraged", "orchestration"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];
export const DEFAULT_DELEGATION_MODE: DelegationMode = "normal";
export const DelegationModeSchema = Schema.Literals(DELEGATION_MODES);
export const isDelegationMode = Schema.is(DelegationModeSchema);

export const WORKTREE_HOOK_EVENTS = ["WorktreeCreate", "WorktreeRemove"] as const;
export type WorktreeHookEvent = (typeof WORKTREE_HOOK_EVENTS)[number];
const MAX_WORKTREE_HOOKS_PER_EVENT = 16;
const MAX_WORKTREE_HOOK_ARGUMENTS = 64;
const MAX_WORKTREE_HOOK_ARGUMENT_CHARS = 4_096;
const MAX_WORKTREE_HOOK_TIMEOUT_SECONDS = 3_600;
export const DEFAULT_WORKTREE_HOOK_TIMEOUT_SECONDS: Readonly<Record<WorktreeHookEvent, number>> = {
  WorktreeCreate: 600,
  WorktreeRemove: 60,
};
/** The argv of a command run without a shell at the root of an isolated writer or prepared tree. */
const WorktreeHookCommandSchema = Schema.Array(
  Schema.String.check(
    Schema.isBetweenLength(1, MAX_WORKTREE_HOOK_ARGUMENT_CHARS),
    Schema.isPattern(/\S/u),
  ),
).check(Schema.isBetweenLength(1, MAX_WORKTREE_HOOK_ARGUMENTS));
export interface WorktreeHook {
  readonly command: ReadonlyArray<string>;
  /** Seconds; defaults per event (DEFAULT_WORKTREE_HOOK_TIMEOUT_SECONDS). */
  readonly timeout?: number;
}
/** Claude Code-style worktree hooks, which run after the engine creates or before it removes a tree. */
type WorktreeHooks = Partial<Readonly<Record<WorktreeHookEvent, ReadonlyArray<WorktreeHook>>>>;
/** WorktreeCreate setup that can't run as declared; every tree's setup fails instead of skipping it. */
export interface InvalidWorktreeCreate {
  /** Diagnostics naming the invalid declarations. */
  readonly invalid: ReadonlyArray<string>;
}
/** WorktreeCreate hooks in run order, or setup blocked by an invalid declaration. */
export type WorktreeCreateSetup = ReadonlyArray<WorktreeHook> | InvalidWorktreeCreate;

export const MIN_DIRECT_CHILDREN = 1;
export const MAX_DIRECT_CHILDREN = 32;
/** Optional cap, in US dollars, on what one session's subagents may spend before new starts stop. */
const MAX_SESSION_SPEND_LIMIT = 100_000;

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

interface SubagentProfileSet {
  readonly profiles: Partial<Readonly<Record<ProfileId, DeclaredProfileRoute>>>;
}

interface SubagentConfigFile {
  readonly version?: number | undefined;
  readonly defaultProfileSet?: string | undefined;
  readonly profileSets?: Readonly<Record<string, SubagentProfileSet>> | undefined;
  readonly nesting?: SubagentNestingOverrides | undefined;
  readonly writerWorkspaceMode?: WriterWorkspaceMode | undefined;
  readonly delegation?: DelegationMode | undefined;
  readonly hooks?: WorktreeHooks | undefined;
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
  /** The document declares a `sessionSpendLimit` that can't be used; spending fails closed. */
  readonly invalidSessionSpendLimit: boolean;
  /** Diagnostics of WorktreeCreate declarations that can't run; tree setup fails closed. */
  readonly invalidWorktreeCreate: ReadonlyArray<string>;
  readonly unsupportedVersion: boolean;
}

const NESTING_BOUNDS = {
  maxDirectChildren: { minimum: MIN_DIRECT_CHILDREN, maximum: MAX_DIRECT_CHILDREN },
  maxDepth: { minimum: MIN_SUBAGENT_DEPTH, maximum: MAX_SUBAGENT_DEPTH },
  /** Active subagent processes allowed at once across the whole tree. */
  maxActiveRuns: { minimum: MIN_ACTIVE_RUNS, maximum: MAX_ACTIVE_RUNS },
} as const;
type NestingField = keyof typeof NESTING_BOUNDS;
const NESTING_FIELDS: ReadonlyArray<NestingField> = [
  "maxDirectChildren",
  "maxDepth",
  "maxActiveRuns",
];

const boundedInteger = ({ minimum, maximum }: { minimum: number; maximum: number }) =>
  Schema.optionalKey(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(minimum),
      Schema.isLessThanOrEqualTo(maximum),
    ),
  );

/** One scope's nesting limits; each omitted field inherits from the next scope. */
export const SubagentNestingOverridesSchema = Schema.Struct({
  maxDirectChildren: boundedInteger(NESTING_BOUNDS.maxDirectChildren),
  maxDepth: boundedInteger(NESTING_BOUNDS.maxDepth),
  maxActiveRuns: boundedInteger(NESTING_BOUNDS.maxActiveRuns),
});
export type SubagentNestingOverrides = typeof SubagentNestingOverridesSchema.Type;

export interface SubagentNestingPolicy {
  readonly maxDirectChildren: number;
  readonly maxDepth: number;
  readonly maxActiveRuns?: number;
}

export const DEFAULT_SUBAGENT_NESTING_POLICY: SubagentNestingPolicy = Object.freeze({
  maxDirectChildren: 12,
  maxDepth: 3,
  maxActiveRuns: DEFAULT_MAX_ACTIVE_RUNS,
});

export const mergeSubagentNesting = (
  inherited: SubagentNestingPolicy,
  overrides: SubagentNestingOverrides | undefined,
): SubagentNestingPolicy => Object.freeze({ ...inherited, ...overrides });

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

/** Strictly decodes an edit; documents degrade per field instead (decodeDocumentNesting). */
export const decodeSubagentNestingOverrides = flow(
  decodeUnknownOrUndefined(SubagentNestingOverridesSchema, EXACT_FIELDS),
  (nesting): SubagentNestingOverrides | undefined => nesting && Object.freeze({ ...nesting }),
);

/**
 * Floors a finite number and clamps it to its bounds, with a diagnostic when that changed it;
 * anything else is undefined so the caller decides how it fails.
 */
const flooredInBounds = (
  value: FieldValue,
  minimum: number,
  maximum: number,
  path: string,
  diagnostics: string[],
): number | undefined => {
  if (!Predicate.isNumber(value) || !Number.isFinite(value)) return undefined;
  const bounded = Math.min(maximum, Math.max(minimum, Math.floor(value)));
  if (bounded !== value) diagnostics.push(path);
  return bounded;
};

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

const decodeDeclaredProfileCandidate = flow(
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
  readonly invalidSessionSpendLimit: boolean;
  readonly invalidWorktreeCreate: ReadonlyArray<string>;
}

const EMPTY_BODY: DecodedBody = Object.freeze({
  file: Object.freeze({}),
  invalidProfileSetRoutes: Object.freeze({}),
  invalidProfileSets: Object.freeze([]),
  invalidDefaultProfileSet: false,
  invalidAgents: Object.freeze([]),
  invalidAgentsContainer: false,
  invalidSessionSpendLimit: false,
  invalidWorktreeCreate: Object.freeze([]),
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
// Tool names reach the Pi child's comma-separated tool argument, as the root's own names do.
const CustomAgentToolNamesSchema = Schema.Array(
  Schema.String.check(
    Schema.isBetweenLength(1, MAX_CUSTOM_AGENT_TOOL_NAME_CHARS),
    Schema.isPattern(/^[^\s,\p{Cc}](?:[^,\p{Cc}]*[^\s,\p{Cc}])?$/u),
  ),
).check(Schema.isMaxLength(MAX_CUSTOM_AGENT_TOOL_NAMES));
// The description is display text, cut to its bound after decoding; instructions are not, since
// cutting them would change what the agent does.
const CustomAgentSchema = Schema.Struct({
  description: Schema.String.check(Schema.isPattern(/\S/u)),
  instructions: Schema.String.check(
    Schema.isPattern(/\S/u),
    Schema.makeFilter((instructions: string) =>
      utf8.encode(instructions).length <= MAX_CUSTOM_AGENT_INSTRUCTIONS_BYTES
        ? true
        : "Agent instructions exceed 128 KiB.",
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
const decodeCustomAgentDefinition = flow(
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
    // Isolation chooses a writer's workspace, so a read-only agent can't set it.
    if (agent?.isolation !== undefined && agent.writeIntent === "read-only") {
      diagnostics.push(`${entryPath}.isolation`);
      invalidAgents.push(name);
    } else if (agent) {
      const cut = agent.description.length > MAX_CUSTOM_AGENT_DESCRIPTION_CHARS;
      if (cut) diagnostics.push(`${entryPath}.description`);
      agents[name] = cut
        ? { ...agent, description: clipText(agent.description, MAX_CUSTOM_AGENT_DESCRIPTION_CHARS) }
        : agent;
    } else {
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
  "hooks",
  "sessionSpendLimit",
  "agents",
]);

const decodeRootField = <S extends Schema.ConstraintDecoder<unknown>>(
  root: UnknownRecord,
  key: string,
  scope: string,
  diagnostics: string[],
  schema: S,
): S["Type"] | undefined => {
  if (!Object.hasOwn(root, key)) return undefined;
  const decoded = decodeUnknownOrUndefined(schema)(root[key]);
  if (decoded === undefined) diagnostics.push(`${scope}.${key}`);
  return decoded;
};

const NESTING_KEYS: ReadonlySet<string> = new Set(NESTING_FIELDS);

/** Nesting limits are safety controls, so a value that isn't a number takes its most restrictive bound. */
const MOST_RESTRICTIVE_NESTING: SubagentNestingOverrides = Object.freeze({
  maxDirectChildren: NESTING_BOUNDS.maxDirectChildren.minimum,
  maxDepth: NESTING_BOUNDS.maxDepth.minimum,
  maxActiveRuns: NESTING_BOUNDS.maxActiveRuns.minimum,
});

const decodeDocumentNesting = (
  value: FieldValue,
  path: string,
  diagnostics: string[],
): SubagentNestingOverrides | undefined => {
  const record = decodeUnknownRecord(value);
  if (!record) {
    diagnostics.push(path);
    return MOST_RESTRICTIVE_NESTING;
  }
  if (!hasOnlyKeys(record, NESTING_KEYS)) diagnostics.push(`${path}.<unknown>`);
  const nesting: { -readonly [Field in NestingField]?: number } = {};
  for (const field of NESTING_FIELDS) {
    if (!Object.hasOwn(record, field)) continue;
    const { minimum, maximum } = NESTING_BOUNDS[field];
    const fieldPath = `${path}.${field}`;
    const limit = flooredInBounds(record[field], minimum, maximum, fieldPath, diagnostics);
    if (limit === undefined) diagnostics.push(fieldPath);
    nesting[field] = limit ?? minimum;
  }
  return Object.keys(nesting).length > 0 ? Object.freeze(nesting) : undefined;
};

const decodeSessionSpendLimit = (
  value: FieldValue,
  path: string,
  diagnostics: string[],
): number | undefined => {
  // A limit has no meaningful minimum to clamp up to; the caller fails a nonpositive one closed.
  if (!Predicate.isNumber(value) || !Number.isFinite(value) || value <= 0) {
    diagnostics.push(path);
    return undefined;
  }
  if (value <= MAX_SESSION_SPEND_LIMIT) return value;
  diagnostics.push(path);
  return MAX_SESSION_SPEND_LIMIT;
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

const decodeHookCommand = decodeUnknownOrUndefined(WorktreeHookCommandSchema);
const HOOK_KEYS: ReadonlySet<string> = new Set(["command", "timeout"]);
const HOOK_EVENT_KEYS: ReadonlySet<string> = new Set(WORKTREE_HOOK_EVENTS);

/** A hook without a valid command or timeout, or with keys it doesn't understand, is invalid. */
const decodeWorktreeHook = (
  value: FieldValue,
  path: string,
  diagnostics: string[],
): WorktreeHook | undefined => {
  const record = decodeUnknownRecord(value);
  const command = record && decodeHookCommand(record.command);
  if (!record || !command || !hasOnlyKeys(record, HOOK_KEYS)) return undefined;
  if (!Object.hasOwn(record, "timeout"))
    return Object.freeze({ command: Object.freeze([...command]) });
  const timeout = flooredInBounds(
    record.timeout,
    1,
    MAX_WORKTREE_HOOK_TIMEOUT_SECONDS,
    `${path}.timeout`,
    diagnostics,
  );
  return timeout === undefined
    ? undefined
    : Object.freeze({ command: Object.freeze([...command]), timeout });
};

interface DecodedHookList {
  readonly hooks: ReadonlyArray<WorktreeHook>;
  /** Paths of declarations that were dropped. */
  readonly invalid: ReadonlyArray<string>;
}

const decodeWorktreeHookList = (
  value: FieldValue,
  path: string,
  diagnostics: string[],
): DecodedHookList => {
  const list = decodeUnknownList(value);
  if (!list || list.length > MAX_WORKTREE_HOOKS_PER_EVENT) {
    const invalid = list ? `${path}[${MAX_WORKTREE_HOOKS_PER_EVENT}+]` : path;
    diagnostics.push(invalid);
    return { hooks: [], invalid: [invalid] };
  }
  const invalid: string[] = [];
  const hooks = list.flatMap((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const hook = decodeWorktreeHook(entry, entryPath, diagnostics);
    if (hook) return [hook];
    diagnostics.push(entryPath);
    invalid.push(entryPath);
    return [];
  });
  return { hooks: Object.freeze(hooks), invalid };
};

interface DecodedWorktreeHooks {
  readonly hooks?: WorktreeHooks | undefined;
  readonly invalidCreate: ReadonlyArray<string>;
}

/**
 * WorktreeRemove is best effort, so an invalid hook is dropped and the rest run. WorktreeCreate is
 * sequential setup a writer depends on, so any invalid declaration, including a malformed `hooks`
 * value that could have held it, blocks setup instead of skipping a step.
 */
const decodeWorktreeHooks = (
  value: FieldValue,
  path: string,
  diagnostics: string[],
): DecodedWorktreeHooks => {
  const record = decodeUnknownRecord(value);
  if (!record) {
    diagnostics.push(path);
    return { invalidCreate: [path] };
  }
  if (!hasOnlyKeys(record, HOOK_EVENT_KEYS)) diagnostics.push(`${path}.<unknown>`);
  const hooks: { -readonly [Event in WorktreeHookEvent]?: ReadonlyArray<WorktreeHook> } = {};
  let invalidCreate: ReadonlyArray<string> = [];
  for (const event of WORKTREE_HOOK_EVENTS) {
    if (!Object.hasOwn(record, event)) continue;
    const list = decodeWorktreeHookList(record[event], `${path}.${event}`, diagnostics);
    if (event === "WorktreeCreate") invalidCreate = list.invalid;
    if (list.hooks.length > 0) hooks[event] = list.hooks;
  }
  return {
    ...(Object.keys(hooks).length > 0 && { hooks: Object.freeze(hooks) }),
    invalidCreate,
  };
};

/** Writer isolation is a safety control, so an invalid mode takes the more isolated one. */
const decodeWriterWorkspaceMode = (
  root: UnknownRecord,
  scope: string,
  diagnostics: string[],
): WriterWorkspaceMode | undefined => {
  if (!Object.hasOwn(root, "writerWorkspaceMode")) return undefined;
  const mode = root.writerWorkspaceMode;
  if (isWriterWorkspaceMode(mode)) return mode;
  diagnostics.push(`${scope}.writerWorkspaceMode`);
  return "worktree";
};

const decodeCurrentBody = (
  root: UnknownRecord,
  scope: string,
  diagnostics: string[],
): DecodedBody => {
  const writerWorkspaceMode = decodeWriterWorkspaceMode(root, scope, diagnostics);
  const delegation = decodeRootField(root, "delegation", scope, diagnostics, DelegationModeSchema);
  const hooks = Object.hasOwn(root, "hooks")
    ? decodeWorktreeHooks(root.hooks, `${scope}.hooks`, diagnostics)
    : undefined;
  const spendLimitDeclared = Object.hasOwn(root, "sessionSpendLimit");
  const sessionSpendLimit = spendLimitDeclared
    ? decodeSessionSpendLimit(root.sessionSpendLimit, `${scope}.sessionSpendLimit`, diagnostics)
    : undefined;
  const nesting = Object.hasOwn(root, "nesting")
    ? decodeDocumentNesting(root.nesting, `${scope}.nesting`, diagnostics)
    : undefined;
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
      ...(nesting !== undefined && { nesting }),
      ...(writerWorkspaceMode !== undefined && { writerWorkspaceMode }),
      ...(delegation !== undefined && { delegation }),
      ...(hooks?.hooks !== undefined && { hooks: hooks.hooks }),
      ...(sessionSpendLimit !== undefined && { sessionSpendLimit }),
      ...(agents && Object.keys(agents.agents).length > 0 && { agents: agents.agents }),
    },
    invalidProfileSetRoutes: decoded?.invalidProfileSetRoutes ?? {},
    invalidProfileSets: decoded?.invalidProfileSets ?? [],
    invalidDefaultProfileSet,
    invalidAgents: agents?.invalidAgents ?? [],
    invalidAgentsContainer: agents?.containerInvalid ?? false,
    invalidSessionSpendLimit: spendLimitDeclared && sessionSpendLimit === undefined,
    invalidWorktreeCreate: hooks?.invalidCreate ?? [],
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
  const file: SubagentConfigFile = {
    ...(version !== undefined && { version }),
    ...body.file,
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
    invalidSessionSpendLimit: body.invalidSessionSpendLimit,
    invalidWorktreeCreate: body.invalidWorktreeCreate,
    unsupportedVersion,
  };
};

export const subagentConfigDecoder = (scope: string) =>
  flow(decodeUnknownRecord, (root) => decodeConfigRoot(root, scope));

export const decodeSubagentConfig = subagentConfigDecoder("config");
