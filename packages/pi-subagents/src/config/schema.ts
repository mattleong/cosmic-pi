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

export const SUBAGENT_CONFIG_BASENAME = "pi-subagents.json";
export const SUBAGENT_CONFIG_VERSION = 6;
export const MAX_PROFILE_SETS = 32;

export const WRITER_WORKSPACE_MODES = ["worktree", "shared-checkout"] as const;
export type WriterWorkspaceMode = (typeof WRITER_WORKSPACE_MODES)[number];
export const DEFAULT_WRITER_WORKSPACE_MODE: WriterWorkspaceMode = "shared-checkout";
export const WriterWorkspaceModeSchema = Schema.Literals(WRITER_WORKSPACE_MODES);

export const SUBAGENT_FEATURE_TOGGLES = ["ultracode"] as const;
export type SubagentFeatureToggle = (typeof SUBAGENT_FEATURE_TOGGLES)[number];
export type SubagentFeatureToggles = Readonly<Record<SubagentFeatureToggle, boolean>>;
export const DEFAULT_SUBAGENT_FEATURE_TOGGLES: SubagentFeatureToggles = Object.freeze({
  ultracode: false,
});
export type SubagentFeatureSource = "default" | "global" | "project" | "session";
export const isSubagentFeatureToggle = <Value>(
  value: Value,
): value is Value & SubagentFeatureToggle =>
  SUBAGENT_FEATURE_TOGGLES.some((toggle) => toggle === value);

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
  readonly ultracode?: boolean | undefined;
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

const decodedRecord = <ValueInput>(value: ValueInput) =>
  invokeHostCallback(() => (Predicate.isObject(value) ? value : undefined), undefined);

const ownKeysAre = <Fields extends object>(record: Fields, allowed: ReadonlySet<string>): boolean =>
  invokeHostCallback(() => Object.keys(record).every((key) => allowed.has(key)), false);

const nullPrototypeRecord = <Value>() => {
  const record: Record<string, Value> = {};
  Object.setPrototypeOf(record, null);
  return record;
};

export const decodeSubagentNesting = <ValueInput>(
  value: ValueInput,
): SubagentNestingPolicy | undefined => {
  const record = decodedRecord(value);
  if (!record || !ownKeysAre(record, NESTING_KEYS)) return undefined;
  const decoded = decodeUnknownOrUndefined(SubagentNestingSchema, record);
  return decoded && Object.freeze({ ...decoded });
};

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

const readField = <Fields extends object>(
  record: Fields,
  key: string,
  path: string,
  diagnostics: string[],
) => {
  try {
    if (!Predicate.isObject(record) || !Object.hasOwn(record, key))
      return { present: false as const };
    return { present: true as const, value: record[key] };
  } catch {
    diagnostics.push(path);
    return { present: true as const };
  }
};

type OwnDataProperty =
  | { readonly valid: true; readonly present: false }
  | { readonly valid: true; readonly present: true; readonly value: unknown }
  | { readonly valid: false };

export const ownDataProperty = <ValueInput>(value: ValueInput, key: string): OwnDataProperty =>
  invokeHostCallback(
    (): OwnDataProperty => {
      if (!Predicate.isObjectKeyword(value)) return { valid: true, present: false };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return { valid: true, present: false };
      return "value" in descriptor
        ? { valid: true, present: true, value: descriptor.value }
        : { valid: false };
    },
    { valid: false },
  );

export const ownDenseArray = <ValueInput>(
  value: ValueInput,
  maxLength: number,
): ReadonlyArray<unknown> | undefined =>
  invokeHostCallback(() => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = ownDataProperty(value, "length");
    if (
      !length.valid ||
      !length.present ||
      !Predicate.isNumber(length.value) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > maxLength ||
      Reflect.ownKeys(value).length !== length.value + 1
    )
      return undefined;
    const elements: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const element = ownDataProperty(value, String(index));
      if (!element.valid || !element.present) return undefined;
      elements.push(element.value);
    }
    return elements;
  }, undefined);

const CANDIDATE_KEYS: ReadonlyArray<string> = [...PROFILE_CANDIDATE_BASE_KEYS, "openaiFastMode"];
const CANDIDATE_KEY_SET = new Set(CANDIDATE_KEYS);
const OPTIONAL_CANDIDATE_KEYS = new Set(["closeOnReport", "openaiFastMode"]);

const candidateFields = <Fields extends object>(record: Fields) => {
  const values: Array<readonly [string, unknown]> = [];
  let decodable = true;
  for (const key of CANDIDATE_KEYS) {
    const field = ownDataProperty(record, key);
    if (!field.valid || (!OPTIONAL_CANDIDATE_KEYS.has(key) && !field.present)) decodable = false;
    else if (field.present) values.push([key, field.value]);
  }
  return { decodable, values };
};

export const decodeDeclaredProfileCandidate = <ValueInput>(
  value: ValueInput,
): DeclaredProfileCandidate | undefined => {
  const record = decodedRecord(value);
  if (!record || !ownKeysAre(record, CANDIDATE_KEY_SET)) return undefined;
  const { decodable, values } = candidateFields(record);
  const decoded = decodable
    ? decodeUnknownOrUndefined(CandidateContractSchema, Object.fromEntries(values))
    : undefined;
  return decoded &&
    profileCandidateValidationIssues(normalizeProfileCandidate(decoded)).length === 0
    ? decoded
    : undefined;
};

export const decodeProfileCandidate = <ValueInput>(
  value: ValueInput,
): ProfileCandidate | undefined => {
  const declared = decodeDeclaredProfileCandidate(value);
  return declared && normalizeProfileCandidate(declared);
};

export const decodeProfileRoute = <ValueInput>(value: ValueInput): ProfileRoute | undefined =>
  invokeHostCallback(() => {
    if (!Predicate.isObject(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    const field = ownDataProperty(value, "candidates");
    const inputs =
      keys.length === 1 && keys[0] === "candidates" && field.valid && field.present
        ? ownDenseArray(field.value, MAX_PROFILE_CANDIDATES)
        : undefined;
    const candidates = inputs?.map((input) => decodeProfileCandidate(input));
    return candidates?.every(Predicate.isNotUndefined) ? { candidates } : undefined;
  }, undefined);

const decodeRoute = <ValueInput>(
  value: ValueInput,
  path: string,
  diagnostics: string[],
): DeclaredProfileRoute | undefined => {
  if (value === "disabled") return "disabled";
  const length = invokeHostCallback(() => (Array.isArray(value) ? value.length : -1), Number.NaN);
  if (length === -1) {
    const candidate = decodeProfileCandidate(value);
    if (!candidate) diagnostics.push(path);
    return candidate;
  }
  if (!(length > 0 && length <= MAX_PROFILE_CANDIDATES)) {
    diagnostics.push(
      length > MAX_PROFILE_CANDIDATES ? `${path}[${MAX_PROFILE_CANDIDATES}+]` : path,
    );
    return undefined;
  }
  const candidates = Array.from({ length }, (_, index) => {
    const candidate = invokeHostCallback(
      () => (Array.isArray(value) ? decodeProfileCandidate(value[index]) : undefined),
      undefined,
    );
    if (!candidate) diagnostics.push(`${path}[${index}]`);
    return candidate;
  });
  return candidates.every(Predicate.isNotUndefined) ? candidates : undefined;
};

interface DecodedProfiles {
  readonly profiles: Partial<Record<ProfileId, DeclaredProfileRoute>>;
  readonly invalidRoutes: ReadonlyArray<ProfileId>;
}

const decodeProfiles = <ValueInput>(
  value: ValueInput,
  path: string,
  diagnostics: string[],
): DecodedProfiles | undefined => {
  const decodedProfiles = decodedRecord(value);
  if (!decodedProfiles) {
    diagnostics.push(path);
    return undefined;
  }
  const profiles: Partial<Record<ProfileId, DeclaredProfileRoute>> = {};
  const invalidRoutes: ProfileId[] = [];
  for (const id of PROFILE_IDS) {
    const routePath = `${path}.${id}`;
    const field = readField(decodedProfiles, id, routePath, diagnostics);
    if (!field.present) continue;
    const route = decodeRoute(field.value, routePath, diagnostics);
    if (route === undefined) invalidRoutes.push(id);
    else profiles[id] = route;
  }
  if (!ownKeysAre(decodedProfiles, new Set<string>(PROFILE_IDS)))
    diagnostics.push(`${path}.<unknown>`);
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

const decodeProfileSets = <ValueInput>(
  value: ValueInput,
  path: string,
  diagnostics: string[],
): Pick<DecodedBody, "invalidProfileSetRoutes" | "invalidProfileSets"> & {
  readonly sets: Record<string, SubagentProfileSet>;
} => {
  const record = decodedRecord(value);
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
    const field = readField(record, name, setPath, diagnostics);
    const setRecord = field.present ? decodedRecord(field.value) : undefined;
    if (!setRecord || !ownKeysAre(setRecord, SET_KEYS)) {
      diagnostics.push(setPath);
      invalidProfileSets.push(name);
      return;
    }
    const profilesPath = `${setPath}.profiles`;
    const profilesField = readField(setRecord, "profiles", profilesPath, diagnostics);
    if (!profilesField.present) diagnostics.push(profilesPath);
    const decoded = profilesField.present
      ? decodeProfiles(profilesField.value, profilesPath, diagnostics)
      : undefined;
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
  ...SUBAGENT_FEATURE_TOGGLES,
]);

const readRootField = <S extends Schema.Constraint, Fields extends object>(
  rawRoot: Fields,
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

const decodeDefaultProfileSet = <Fields extends object>(
  rawRoot: Fields,
  scope: string,
  diagnostics: string[],
) => {
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

const decodeCurrentBody = <Fields extends object>(
  rawRoot: Fields,
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
  const toggles: Partial<Record<SubagentFeatureToggle, boolean>> = {};
  for (const toggle of SUBAGENT_FEATURE_TOGGLES) {
    const enabled = readRootField(rawRoot, toggle, scope, diagnostics, Schema.Boolean);
    if (enabled !== undefined) toggles[toggle] = enabled;
  }
  const setsField = readField(rawRoot, "profileSets", `${scope}.profileSets`, diagnostics);
  const decoded = setsField.present
    ? decodeProfileSets(setsField.value, `${scope}.profileSets`, diagnostics)
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
      ...toggles,
    },
    invalidProfileSetRoutes: decoded?.invalidProfileSetRoutes ?? {},
    invalidProfileSets: decoded?.invalidProfileSets ?? [],
    invalidDefaultProfileSet,
  };
};

const decodeRootNesting = <Fields extends object>(
  rawRoot: Fields,
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

export function decodeSubagentConfig<InputInput>(
  input: InputInput,
  scope = "config",
): DecodedSubagentConfig {
  const diagnostics: string[] = [];
  const decodedRoot = decodedRecord(input);
  const rawRoot = decodedRoot ?? {};
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
}
