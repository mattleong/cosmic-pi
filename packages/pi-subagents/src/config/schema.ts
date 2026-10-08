import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback, type JsonObject } from "pi-cosmic-core";
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
  type DeclaredProfileRoute,
  type ProfileCandidate,
  type ProfileId,
  type ProfileRoute,
} from "../profiles/model.ts";

export const SUBAGENT_CONFIG_BASENAME = "pi-subagents.json";
export const SUBAGENT_CONFIG_VERSION = 6;
export const PREVIOUS_SUBAGENT_CONFIG_VERSION = 5;
export const LEGACY_SUBAGENT_CONFIG_VERSION = 4;
export const MIGRATED_PROFILE_SET_NAME = "default";
export const MAX_PROFILE_SETS = 32;

export const WRITER_WORKSPACE_MODES = ["worktree", "shared-checkout"] as const;
export type WriterWorkspaceMode = (typeof WRITER_WORKSPACE_MODES)[number];
export const DEFAULT_WRITER_WORKSPACE_MODE: WriterWorkspaceMode = "shared-checkout";
export const WriterWorkspaceModeSchema = Schema.Literals(WRITER_WORKSPACE_MODES);

/**
 * Version-6 feature switches are optional root booleans that Project overrides over Global; an
 * absent declaration inherits, and a session may override both. `ultracode` opts the session
 * into dynamic workflows, so it is off by default.
 */
export const SUBAGENT_FEATURE_TOGGLES = ["ultracode"] as const;
export type SubagentFeatureToggle = (typeof SUBAGENT_FEATURE_TOGGLES)[number];
export type SubagentFeatureToggles = Readonly<Record<SubagentFeatureToggle, boolean>>;
export const DEFAULT_SUBAGENT_FEATURE_TOGGLES: SubagentFeatureToggles = Object.freeze({
  ultracode: false,
});
/** Where a switch's effective value comes from. */
export type SubagentFeatureSource = "default" | "global" | "project" | "session";
export const isSubagentFeatureToggle = <Value>(
  value: Value,
): value is Value & SubagentFeatureToggle =>
  SUBAGENT_FEATURE_TOGGLES.some((toggle) => toggle === value);

export const MIN_DIRECT_CHILDREN = 1;
export const MAX_DIRECT_CHILDREN = 32;
export const MIN_SUBAGENT_DEPTH = 0;
export const MAX_SUBAGENT_DEPTH = 8;

/** At most 64 characters: an alphanumeric at each end around up to 62 name characters. */
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
  /** Scope-normalized view. Versions 4 and 5 expose their legacy `profiles` as set `default`. */
  readonly file: SubagentConfigFile;
  /** Redacted structural paths only; values and set names are never retained. */
  readonly diagnostics: ReadonlyArray<string>;
  /** Invalid routes keyed by a validated, bounded profile-set name. */
  readonly invalidProfileSetRoutes: Readonly<Record<string, ReadonlyArray<ProfileId>>>;
  /** Structurally invalid sets whose validated names may still be repaired or deleted by the UI. */
  readonly invalidProfileSets: ReadonlyArray<string>;
  /** The declared default is malformed, missing, or points at an invalid set. */
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

/** Revoked proxies throw from the Array check itself. */
const decodedRecord = <ValueInput>(value: ValueInput): Readonly<JsonObject> | undefined =>
  invokeHostCallback(
    // SAFETY: This is a shallow hostile-input view used only for guarded field reads; every field
    // is decoded into its concrete domain type before it can enter SubagentConfigFile.
    () => (Predicate.isObject(value) ? (value as ValueInput & Readonly<JsonObject>) : undefined),
    undefined,
  );

const ownKeysAre = (record: Readonly<JsonObject>, allowed: ReadonlySet<string>): boolean =>
  invokeHostCallback(() => Object.keys(record).every((key) => allowed.has(key)), false);

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

const readField = (
  record: Readonly<JsonObject>,
  key: string,
  path: string,
  diagnostics: string[],
) => {
  try {
    if (!Object.hasOwn(record, key)) return { present: false as const };
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

/** Descriptor-safe own read: accessors and throwing hostile objects are invalid, never invoked. */
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

/**
 * Snapshots an ordinary dense array of at most `maxLength` own data elements without consulting
 * an iterator or invoking an accessor; any other value, including an extra own key, is rejected.
 */
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

/** Descriptor-safe reads for every candidate field; the legacy fastMode value keeps its key.
 * Required base fields must be present own values; optional fields must never be accessors. */
const candidateFields = (record: Readonly<JsonObject>, fastModeKey: string) => {
  const values: Array<readonly [string, unknown]> = [];
  let decodable = true;
  for (const key of [...PROFILE_CANDIDATE_BASE_KEYS, fastModeKey]) {
    const field = ownDataProperty(record, key);
    const required = key !== "closeOnReport" && key !== fastModeKey;
    if (!field.valid || (required && !field.present)) decodable = false;
    else if (field.present)
      values.push([key === fastModeKey ? "openaiFastMode" : key, field.value]);
  }
  return { decodable, values };
};

export const isLegacyConfigVersion = <Version>(version: Version): version is Version & (4 | 5) =>
  version === LEGACY_SUBAGENT_CONFIG_VERSION || version === PREVIOUS_SUBAGENT_CONFIG_VERSION;

export const decodeProfileCandidate = <ValueInput>(
  value: ValueInput,
  version = SUBAGENT_CONFIG_VERSION,
): ProfileCandidate | undefined => {
  const record = decodedRecord(value);
  const fastModeKey = isLegacyConfigVersion(version) ? "fastMode" : "openaiFastMode";
  if (!record || !ownKeysAre(record, new Set([...PROFILE_CANDIDATE_BASE_KEYS, fastModeKey])))
    return undefined;
  const { decodable, values } = candidateFields(record, fastModeKey);
  const decoded = decodable
    ? decodeUnknownOrUndefined(CandidateContractSchema, Object.fromEntries(values))
    : undefined;
  const candidate = decoded && normalizeProfileCandidate(decoded);
  return candidate && profileCandidateValidationIssues(candidate).length === 0
    ? candidate
    : undefined;
};

/** Descriptor-safe decode of a runtime `{ candidates }` route; zero candidates means disabled. */
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
  version: number,
  path: string,
  diagnostics: string[],
): DeclaredProfileRoute | undefined => {
  if (value === "disabled") return "disabled";
  // NaN marks a hostile proxy that throws from the Array check or the length read.
  const length = invokeHostCallback(() => (Array.isArray(value) ? value.length : -1), Number.NaN);
  if (length === -1) {
    const candidate = decodeProfileCandidate(value, version);
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
      () => (Array.isArray(value) ? decodeProfileCandidate(value[index], version) : undefined),
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
  version: number,
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
    const route = decodeRoute(field.value, version, routePath, diagnostics);
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
  /** The declared default name itself is malformed. */
  readonly invalidDefaultProfileSet: boolean;
}

// Shared by every decode without a body, so nothing may mutate it.
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
  // SAFETY: These null-prototype maps are populated only with validated set names below.
  const sets = Object.create(null) as Record<string, SubagentProfileSet>;
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
      ? decodeProfiles(profilesField.value, SUBAGENT_CONFIG_VERSION, profilesPath, diagnostics)
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

const ConfigVersionSchema = Schema.Literals([
  LEGACY_SUBAGENT_CONFIG_VERSION,
  PREVIOUS_SUBAGENT_CONFIG_VERSION,
  SUBAGENT_CONFIG_VERSION,
]);
export const isSupportedConfigVersion = Schema.is(ConfigVersionSchema);

/** Allowed root keys per declared version; unsupported versions use the current key set. */
const ROOT_KEYS_BY_VERSION = {
  [LEGACY_SUBAGENT_CONFIG_VERSION]: ["version", "profiles"],
  [PREVIOUS_SUBAGENT_CONFIG_VERSION]: ["version", "profiles", "nesting"],
  [SUBAGENT_CONFIG_VERSION]: [
    "version",
    "defaultProfileSet",
    "profileSets",
    "nesting",
    "writerWorkspaceMode",
    ...SUBAGENT_FEATURE_TOGGLES,
    // Retired and ignored; preserve compatibility with saved v6 files.
    "automaticProfileRouting",
    "scriptedWorkflows",
  ],
} as const;

/** Reads one optional root field, recording its path when it is present but undecodable. */
const readRootField = <S extends Schema.Constraint>(
  rawRoot: Readonly<JsonObject>,
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

/** Current-version body decode: file fields plus null-prototype invalid-set bookkeeping. */
const decodeCurrentBody = (
  rawRoot: Readonly<JsonObject>,
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
  const defaultPath = `${scope}.defaultProfileSet`;
  const defaultField = readField(rawRoot, "defaultProfileSet", defaultPath, diagnostics);
  const defaultProfileSet =
    Predicate.isString(defaultField.value) && isProfileSetName(defaultField.value)
      ? defaultField.value
      : undefined;
  const invalidDefaultProfileSet = defaultField.present && defaultProfileSet === undefined;
  if (invalidDefaultProfileSet) diagnostics.push(defaultPath);
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

/**
 * Version-4/5 body decode: a present root `profiles` is the synthetic default set `default`, so a
 * malformed container fails that default closed exactly like a structurally invalid v6 set.
 */
const decodeLegacyBody = (
  rawRoot: Readonly<JsonObject>,
  scope: string,
  version: 4 | 5,
  diagnostics: string[],
): DecodedBody => {
  const field = readField(rawRoot, "profiles", `${scope}.profiles`, diagnostics);
  if (!field.present) return EMPTY_BODY;
  const decoded = decodeProfiles(field.value, version, `${scope}.profiles`, diagnostics);
  const name = MIGRATED_PROFILE_SET_NAME;
  return {
    file: {
      defaultProfileSet: name,
      ...(decoded && { profileSets: { [name]: { profiles: decoded.profiles } } }),
    },
    invalidProfileSetRoutes:
      decoded && decoded.invalidRoutes.length > 0 ? { [name]: decoded.invalidRoutes } : {},
    invalidProfileSets: decoded ? [] : [name],
    invalidDefaultProfileSet: false,
  };
};

/** Strict version-4/5/6 unknown-boundary decode for one global or project document. */
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
  if (!ownKeysAre(rawRoot, new Set(ROOT_KEYS_BY_VERSION[version ?? SUBAGENT_CONFIG_VERSION])))
    diagnostics.push(`${scope}.<unknown>`);

  const body = isLegacyConfigVersion(version)
    ? decodeLegacyBody(rawRoot, scope, version, diagnostics)
    : version === SUBAGENT_CONFIG_VERSION
      ? decodeCurrentBody(rawRoot, scope, diagnostics)
      : EMPTY_BODY;
  let file: SubagentConfigFile = { ...(version !== undefined && { version }), ...body.file };
  const nestingField = readField(rawRoot, "nesting", `${scope}.nesting`, diagnostics);
  const supportsNesting =
    version === PREVIOUS_SUBAGENT_CONFIG_VERSION || version === SUBAGENT_CONFIG_VERSION;
  if (supportsNesting && nestingField.present) {
    const nesting = decodeSubagentNesting(nestingField.value);
    if (nesting === undefined) diagnostics.push(`${scope}.nesting`);
    else file = { ...file, nesting };
  }

  const defaultName = file.defaultProfileSet;
  // Invalid sets are never decoded into `file.profileSets`, so this also covers them.
  const missingDefault =
    defaultName !== undefined &&
    !(file.profileSets && Object.hasOwn(file.profileSets, defaultName));
  if (missingDefault) diagnostics.push(`${scope}.defaultProfileSet`);
  const unsupportedVersion = version === undefined;
  if (unsupportedVersion) diagnostics.push(`${scope}.version`);

  return {
    file,
    diagnostics: [...new Set(diagnostics)],
    // SAFETY: This null-prototype map is populated only by bounded profile decoders.
    invalidProfileSetRoutes: Object.assign(
      Object.create(null),
      body.invalidProfileSetRoutes,
    ) as Record<string, ReadonlyArray<ProfileId>>,
    invalidProfileSets: body.invalidProfileSets,
    invalidDefaultProfileSet: body.invalidDefaultProfileSet || missingDefault,
    unsupportedVersion,
  };
}
