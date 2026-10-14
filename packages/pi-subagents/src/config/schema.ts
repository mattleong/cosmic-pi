import { flow } from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback } from "pi-cosmic-core";
import {
  MAX_PROFILE_CANDIDATES,
  normalizeProfileCandidate,
  PROFILE_CANDIDATE_BASE_KEYS,
  PROFILE_CANDIDATE_CONTEXTS,
  PROFILE_CANDIDATE_EFFORTS,
  PROFILE_CANDIDATE_HOSTS,
  PROFILE_CANDIDATE_RUNTIMES,
  PROFILE_CANDIDATE_WRITE_INTENTS,
  PROFILE_IDS,
  profileCandidateValidationIssues,
  type DeclaredProfileCandidate,
  type DeclaredProfileRoute,
  type ProfileCandidate,
  type ProfileId,
  type ProfileRoute,
} from "../profiles/model.ts";
import {
  denseElements,
  ownDataProperty,
  ownKeysAre,
  probeFields,
  probeList,
  type ProbedFields,
  type ProbedList,
} from "./probe.ts";

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
const WORKSPACE_SETUP_KEYS = new Set(["command", "timeoutSeconds"]);

export const MIN_DIRECT_CHILDREN = 1;
export const MAX_DIRECT_CHILDREN = 32;
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
}

export interface DecodedSubagentConfig {
  readonly file: SubagentConfigFile;
  readonly diagnostics: ReadonlyArray<string>;
  readonly invalidProfileSetRoutes: Readonly<Record<string, ReadonlyArray<ProfileId>>>;
  readonly invalidProfileSets: ReadonlyArray<string>;
  readonly invalidDefaultProfileSet: boolean;
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
});
export type SubagentNestingPolicy = typeof SubagentNestingSchema.Type;

export const DEFAULT_SUBAGENT_NESTING_POLICY: SubagentNestingPolicy = Object.freeze({
  maxDirectChildren: 12,
  maxDepth: 3,
});

const NESTING_KEYS = new Set(["maxDirectChildren", "maxDepth"]);

const nullPrototypeRecord = <Value>() => {
  const record: Record<string, Value> = {};
  Object.setPrototypeOf(record, null);
  return record;
};

const decodeNestingFields = decodeUnknownOrUndefined(SubagentNestingSchema);

const nestingFromFields = (record: ProbedFields): SubagentNestingPolicy | undefined => {
  if (!ownKeysAre(record, NESTING_KEYS)) return undefined;
  const decoded = decodeNestingFields(record);
  return decoded && Object.freeze({ ...decoded });
};

export const decodeSubagentNesting = flow(
  probeFields,
  (record) => record && nestingFromFields(record),
);

const CandidateContractSchema = Schema.Struct({
  host: Schema.Literals(PROFILE_CANDIDATE_HOSTS),
  runtime: Schema.Literals(PROFILE_CANDIDATE_RUNTIMES),
  model: Schema.String,
  effort: Schema.Literals(PROFILE_CANDIDATE_EFFORTS),
  context: Schema.Literals(PROFILE_CANDIDATE_CONTEXTS),
  writeIntent: Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS),
  openaiFastMode: Schema.optional(Schema.Boolean),
  closeOnReport: Schema.optional(Schema.Literal(true)),
});
const decodeCandidateContract = decodeUnknownOrUndefined(CandidateContractSchema);

const readField = (record: ProbedFields, key: string, path: string, diagnostics: string[]) => {
  try {
    if (!Object.hasOwn(record, key)) return { present: false as const };
    return { present: true as const, value: record[key] };
  } catch {
    diagnostics.push(path);
    return { present: true as const };
  }
};

const CANDIDATE_KEYS: ReadonlyArray<string> = [...PROFILE_CANDIDATE_BASE_KEYS, "openaiFastMode"];
const CANDIDATE_KEY_SET = new Set(CANDIDATE_KEYS);
const OPTIONAL_CANDIDATE_KEYS = new Set(["closeOnReport", "openaiFastMode"]);

const candidateFields = (record: ProbedFields) => {
  const values: Array<readonly [string, ProbedFields[string]]> = [];
  let decodable = true;
  for (const key of CANDIDATE_KEYS) {
    const field = ownDataProperty(record, key);
    if (!field.valid || (!OPTIONAL_CANDIDATE_KEYS.has(key) && !field.present)) decodable = false;
    else if (field.present) values.push([key, field.value]);
  }
  return { decodable, values };
};

const declaredCandidateFromFields = (
  record: ProbedFields,
): DeclaredProfileCandidate | undefined => {
  if (!ownKeysAre(record, CANDIDATE_KEY_SET)) return undefined;
  const { decodable, values } = candidateFields(record);
  const decoded = decodable ? decodeCandidateContract(Object.fromEntries(values)) : undefined;
  return decoded &&
    profileCandidateValidationIssues(normalizeProfileCandidate(decoded)).length === 0
    ? decoded
    : undefined;
};

export const decodeDeclaredProfileCandidate = flow(
  probeFields,
  (record) => record && declaredCandidateFromFields(record),
);

export const decodeProfileCandidate = flow(
  decodeDeclaredProfileCandidate,
  (declared): ProfileCandidate | undefined => declared && normalizeProfileCandidate(declared),
);

const routeFromFields = (record: ProbedFields): ProfileRoute | undefined =>
  invokeHostCallback(() => {
    const keys = Reflect.ownKeys(record);
    const field = ownDataProperty(record, "candidates");
    const list =
      keys.length === 1 && keys[0] === "candidates" && field.valid && field.present
        ? probeList(field.value)
        : undefined;
    const inputs = list && denseElements(list, MAX_PROFILE_CANDIDATES);
    const candidates = inputs?.map((input) => decodeProfileCandidate(input));
    return candidates?.every(Predicate.isNotUndefined) ? { candidates } : undefined;
  }, undefined);

export const decodeProfileRoute = flow(probeFields, (record) => record && routeFromFields(record));

const routeFromList = (
  list: ProbedList,
  path: string,
  diagnostics: string[],
): DeclaredProfileRoute | undefined => {
  const length = invokeHostCallback(() => list.length, Number.NaN);
  if (!(length > 0 && length <= MAX_PROFILE_CANDIDATES)) {
    diagnostics.push(
      length > MAX_PROFILE_CANDIDATES ? `${path}[${MAX_PROFILE_CANDIDATES}+]` : path,
    );
    return undefined;
  }
  const candidates = Array.from({ length }, (_, index) => {
    const candidate = invokeHostCallback(() => decodeProfileCandidate(list[index]), undefined);
    if (!candidate) diagnostics.push(`${path}[${index}]`);
    return candidate;
  });
  return candidates.every(Predicate.isNotUndefined) ? candidates : undefined;
};

const decodeRouteField = (
  record: ProbedFields,
  id: ProfileId,
  path: string,
  diagnostics: string[],
):
  | { readonly present: false }
  | { readonly present: true; readonly route?: DeclaredProfileRoute } => {
  const field = readField(record, id, path, diagnostics);
  if (!field.present) return { present: false };
  if (field.value === "disabled") return { present: true, route: "disabled" };
  const list = probeList(field.value);
  if (list) {
    const route = routeFromList(list, path, diagnostics);
    return route === undefined ? { present: true } : { present: true, route };
  }
  const candidate = decodeProfileCandidate(field.value);
  if (!candidate) diagnostics.push(path);
  return candidate === undefined ? { present: true } : { present: true, route: candidate };
};

interface DecodedProfiles {
  readonly profiles: Partial<Record<ProfileId, DeclaredProfileRoute>>;
  readonly invalidRoutes: ReadonlyArray<ProfileId>;
}

const profilesFromFields = (
  record: ProbedFields,
  path: string,
  diagnostics: string[],
): DecodedProfiles => {
  const profiles: Partial<Record<ProfileId, DeclaredProfileRoute>> = {};
  const invalidRoutes: ProfileId[] = [];
  for (const id of PROFILE_IDS) {
    const field = decodeRouteField(record, id, `${path}.${id}`, diagnostics);
    if (!field.present) continue;
    if (field.route === undefined) invalidRoutes.push(id);
    else profiles[id] = field.route;
  }
  if (!ownKeysAre(record, new Set<string>(PROFILE_IDS))) diagnostics.push(`${path}.<unknown>`);
  return { profiles, invalidRoutes };
};

const SET_KEYS = new Set(["profiles"]);

interface DecodedBody {
  readonly file: SubagentConfigFile;
  readonly invalidProfileSetRoutes: Readonly<Record<string, ReadonlyArray<ProfileId>>>;
  readonly invalidProfileSets: ReadonlyArray<string>;
  readonly invalidDefaultProfileSet: boolean;
}

const EMPTY_BODY: DecodedBody = Object.freeze({
  file: Object.freeze({}),
  invalidProfileSetRoutes: Object.freeze({}),
  invalidProfileSets: Object.freeze([]),
  invalidDefaultProfileSet: false,
});

const decodeProfileSet = (
  record: ProbedFields,
  name: string,
  setPath: string,
  diagnostics: string[],
): DecodedProfiles | undefined => {
  const field = readField(record, name, setPath, diagnostics);
  const setRecord = field.present ? probeFields(field.value) : undefined;
  if (!setRecord || !ownKeysAre(setRecord, SET_KEYS)) {
    diagnostics.push(setPath);
    return undefined;
  }
  const profilesPath = `${setPath}.profiles`;
  const profilesField = readField(setRecord, "profiles", profilesPath, diagnostics);
  const profilesRecord = profilesField.present ? probeFields(profilesField.value) : undefined;
  if (!profilesRecord) {
    diagnostics.push(profilesPath);
    return undefined;
  }
  return profilesFromFields(profilesRecord, profilesPath, diagnostics);
};

const decodeProfileSets = (
  record: ProbedFields | undefined,
  path: string,
  diagnostics: string[],
): Pick<DecodedBody, "invalidProfileSetRoutes" | "invalidProfileSets"> & {
  readonly sets: Record<string, SubagentProfileSet>;
} => {
  const names = record && invokeHostCallback(() => Object.keys(record), undefined);
  if (!record || !names || names.length > MAX_PROFILE_SETS) {
    diagnostics.push(
      names && names.length > MAX_PROFILE_SETS ? `${path}[${MAX_PROFILE_SETS}+]` : path,
    );
    return { sets: {}, invalidProfileSetRoutes: {}, invalidProfileSets: [] };
  }
  const sets = nullPrototypeRecord<SubagentProfileSet>();
  const invalidProfileSetRoutes: Record<string, ReadonlyArray<ProfileId>> = {};
  const invalidProfileSets: string[] = [];
  names.forEach((name, index) => {
    const setPath = `${path}[${index}]`;
    if (!isProfileSetName(name)) {
      diagnostics.push(`${setPath}.name`);
      return;
    }
    const decoded = decodeProfileSet(record, name, setPath, diagnostics);
    if (!decoded) {
      invalidProfileSets.push(name);
      return;
    }
    sets[name] = { profiles: decoded.profiles };
    if (decoded.invalidRoutes.length > 0) invalidProfileSetRoutes[name] = decoded.invalidRoutes;
  });
  return { sets, invalidProfileSetRoutes, invalidProfileSets };
};

export const isSupportedConfigVersion = Schema.is(Schema.Literal(SUBAGENT_CONFIG_VERSION));

const ROOT_KEYS = new Set([
  "version",
  "defaultProfileSet",
  "profileSets",
  "nesting",
  "writerWorkspaceMode",
  "delegation",
  "workspaceSetup",
]);

const readRootField = <S extends Schema.Constraint>(
  rawRoot: ProbedFields,
  key: string,
  scope: string,
  diagnostics: string[],
  schema: S,
): S["Type"] | undefined => {
  const path = `${scope}.${key}`;
  const field = readField(rawRoot, key, path, diagnostics);
  if (!field.present) return undefined;
  if (Schema.is(schema)(field.value)) return field.value;
  diagnostics.push(path);
  return undefined;
};

const decodeDefaultProfileSet = (rawRoot: ProbedFields, scope: string, diagnostics: string[]) => {
  const defaultPath = `${scope}.defaultProfileSet`;
  const defaultField = readField(rawRoot, "defaultProfileSet", defaultPath, diagnostics);
  const defaultProfileSet =
    Predicate.isString(defaultField.value) && isProfileSetName(defaultField.value)
      ? defaultField.value
      : undefined;
  const invalidDefaultProfileSet = defaultField.present && defaultProfileSet === undefined;
  if (invalidDefaultProfileSet) diagnostics.push(defaultPath);
  return { defaultProfileSet, invalidDefaultProfileSet };
};

// Setup commands are repository-specific, so only a project document may declare one.
const decodeWorkspaceSetup = (
  rawRoot: ProbedFields,
  scope: string,
  diagnostics: string[],
): WorkspaceSetup | undefined => {
  const path = `${scope}.workspaceSetup`;
  const field = readField(rawRoot, "workspaceSetup", path, diagnostics);
  if (!field.present) return undefined;
  const fields = probeFields(field.value);
  if (
    scope === "project" &&
    fields !== undefined &&
    ownKeysAre(fields, WORKSPACE_SETUP_KEYS) &&
    Schema.is(WorkspaceSetupSchema)(fields)
  )
    return Object.freeze({ ...fields, command: Object.freeze([...fields.command]) });
  diagnostics.push(path);
  return undefined;
};

const decodeCurrentBody = (
  rawRoot: ProbedFields,
  scope: string,
  diagnostics: string[],
): DecodedBody => {
  const writerWorkspaceMode = readRootField(
    rawRoot,
    "writerWorkspaceMode",
    scope,
    diagnostics,
    WriterWorkspaceModeSchema,
  );
  const delegation = readRootField(rawRoot, "delegation", scope, diagnostics, DelegationModeSchema);
  const workspaceSetup = decodeWorkspaceSetup(rawRoot, scope, diagnostics);
  const setsField = readField(rawRoot, "profileSets", `${scope}.profileSets`, diagnostics);
  const decoded = setsField.present
    ? decodeProfileSets(probeFields(setsField.value), `${scope}.profileSets`, diagnostics)
    : undefined;
  const { defaultProfileSet, invalidDefaultProfileSet } = decodeDefaultProfileSet(
    rawRoot,
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
    },
    invalidProfileSetRoutes: decoded?.invalidProfileSetRoutes ?? {},
    invalidProfileSets: decoded?.invalidProfileSets ?? [],
    invalidDefaultProfileSet,
  };
};

const decodeRootNesting = (
  rawRoot: ProbedFields,
  scope: string,
  supported: boolean,
  diagnostics: string[],
): SubagentNestingPolicy | undefined => {
  const nestingField = readField(rawRoot, "nesting", `${scope}.nesting`, diagnostics);
  if (!supported || !nestingField.present) return undefined;
  const nesting = decodeSubagentNesting(nestingField.value);
  if (nesting === undefined) diagnostics.push(`${scope}.nesting`);
  return nesting;
};

const declaresMissingDefault = (file: SubagentConfigFile): boolean => {
  const defaultName = file.defaultProfileSet;
  return (
    defaultName !== undefined && !(file.profileSets && Object.hasOwn(file.profileSets, defaultName))
  );
};

const decodeConfigRoot = (
  decodedRoot: ProbedFields | undefined,
  scope: string,
): DecodedSubagentConfig => {
  const diagnostics: string[] = [];
  const rawRoot: ProbedFields = decodedRoot ?? {};
  if (!decodedRoot) diagnostics.push(scope);
  const rawVersion = readField(rawRoot, "version", `${scope}.version`, diagnostics).value;
  const version = isSupportedConfigVersion(rawVersion) ? rawVersion : undefined;
  if (!ownKeysAre(rawRoot, ROOT_KEYS)) diagnostics.push(`${scope}.<unknown>`);

  const body = version === undefined ? EMPTY_BODY : decodeCurrentBody(rawRoot, scope, diagnostics);
  const nesting = decodeRootNesting(rawRoot, scope, version !== undefined, diagnostics);
  const file: SubagentConfigFile = {
    ...(version !== undefined && { version }),
    ...body.file,
    ...(nesting !== undefined && { nesting }),
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
    unsupportedVersion,
  };
};

export const subagentConfigDecoder = (scope: string) =>
  flow(probeFields, (root) => decodeConfigRoot(root, scope));

export const decodeSubagentConfig = subagentConfigDecoder("config");
