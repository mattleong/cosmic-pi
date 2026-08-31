import type { JsonObject } from "pi-cosmic-core";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import {
  MAX_PROFILE_CANDIDATES,
  normalizeProfileCandidate,
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
} from "../profiles/model.ts";

export const SUBAGENT_CONFIG_BASENAME = "pi-subagents.json";
export const SUBAGENT_CONFIG_VERSION = 6;
export const PREVIOUS_SUBAGENT_CONFIG_VERSION = 5;
export const LEGACY_SUBAGENT_CONFIG_VERSION = 4;
export const MIGRATED_PROFILE_SET_NAME = "default";
export const MAX_PROFILE_SETS = 32;
export const MAX_PROFILE_SET_NAME_CHARS = 64;

export const DEFAULT_MAX_DIRECT_CHILDREN = 12;
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
export const MIN_DIRECT_CHILDREN = 1;
export const MAX_DIRECT_CHILDREN = 32;
export const MIN_SUBAGENT_DEPTH = 0;
export const MAX_SUBAGENT_DEPTH = 8;

const PROFILE_SET_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9])?$/u;

export const isProfileSetName = (value: string): boolean =>
  value.length <= MAX_PROFILE_SET_NAME_CHARS && PROFILE_SET_NAME_PATTERN.test(value);

export const normalizeProfileSetName = (value: string): string | undefined => {
  const normalized = value.trim();
  return isProfileSetName(normalized) ? normalized : undefined;
};

export interface SubagentNestingPolicy {
  readonly maxDirectChildren: number;
  readonly maxDepth: number;
}

export const DEFAULT_SUBAGENT_NESTING_POLICY: SubagentNestingPolicy = Object.freeze({
  maxDirectChildren: DEFAULT_MAX_DIRECT_CHILDREN,
  maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
});

export interface SubagentProfileSet {
  readonly profiles: Partial<Readonly<Record<ProfileId, DeclaredProfileRoute>>>;
}

export interface SubagentConfigFile {
  readonly version?: number | undefined;
  readonly defaultProfileSet?: string | undefined;
  readonly profileSets?: Readonly<Record<string, SubagentProfileSet>> | undefined;
  readonly nesting?: SubagentNestingPolicy | undefined;
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
  /** Compatibility projection for the declared default set. */
  readonly invalidProfileRoutes: ReadonlyArray<ProfileId>;
  readonly unsupportedVersion: boolean;
}

export const ProfileHostSchema = Schema.Literals(PROFILE_CANDIDATE_HOSTS);
export const ProfileRuntimeSchema = Schema.Literals(PROFILE_CANDIDATE_RUNTIMES);
export const ProfileEffortSchema = Schema.Literals(PROFILE_CANDIDATE_EFFORTS);
export const ProfileContextSchema = Schema.Literals(PROFILE_CANDIDATE_CONTEXTS);
export const ProfileWriteIntentSchema = Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS);

const NestingContractSchema = Schema.Struct({
  maxDirectChildren: Schema.Number.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(MIN_DIRECT_CHILDREN),
    Schema.isLessThanOrEqualTo(MAX_DIRECT_CHILDREN),
  ),
  maxDepth: Schema.Number.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(MIN_SUBAGENT_DEPTH),
    Schema.isLessThanOrEqualTo(MAX_SUBAGENT_DEPTH),
  ),
});

const NESTING_KEYS = new Set(["maxDirectChildren", "maxDepth"]);

export const decodeSubagentNesting = <ValueInput>(
  value: ValueInput,
): SubagentNestingPolicy | undefined => {
  const record = decodedRecord(value);
  if (!record || !ownKeysAre(record, NESTING_KEYS)) return undefined;
  try {
    const decoded = Schema.decodeUnknownOption(NestingContractSchema)(record);
    return Option.isSome(decoded) ? Object.freeze({ ...decoded.value }) : undefined;
  } catch {
    return undefined;
  }
};

const CANDIDATE_BASE_KEYS = [
  "host",
  "runtime",
  "model",
  "effort",
  "context",
  "writeIntent",
  "closeOnReport",
] as const;
const CandidateContractSchema = Schema.Struct({
  host: ProfileHostSchema,
  runtime: ProfileRuntimeSchema,
  model: Schema.String,
  effort: ProfileEffortSchema,
  context: ProfileContextSchema,
  writeIntent: ProfileWriteIntentSchema,
  openaiFastMode: Schema.optional(Schema.Boolean),
  closeOnReport: Schema.optional(Schema.Boolean),
});

const safeOwnKeys = (record: Readonly<JsonObject>): ReadonlyArray<string> | undefined => {
  try {
    return Object.keys(record);
  } catch {
    return undefined;
  }
};

const ownKeysAre = (record: Readonly<JsonObject>, allowed: ReadonlySet<string>): boolean => {
  const keys = safeOwnKeys(record);
  return keys !== undefined && keys.every((key) => allowed.has(key));
};

const decodedRecord = <ValueInput>(value: ValueInput): Readonly<JsonObject> | undefined => {
  try {
    if (!hasObjectRuntimeType(value) || value === null || Array.isArray(value)) return undefined;
    // SAFETY: This is a shallow hostile-input view used only for guarded field reads; every field
    // is decoded into its concrete domain type before it can enter SubagentConfigFile.
    return value as ValueInput & Readonly<JsonObject>;
  } catch {
    return undefined;
  }
};

const readField = (
  record: Readonly<JsonObject>,
  key: string,
  path: string,
  diagnostics: string[],
) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false as const };
    return { present: true as const, value: record[key] };
  } catch {
    diagnostics.push(path);
    return { present: true as const };
  }
};

const readCandidateField = (record: Readonly<JsonObject>, key: string) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) return { readable: true as const, present: false as const };
    return "value" in descriptor
      ? { readable: true as const, present: true as const, value: descriptor.value }
      : { readable: false as const, present: true as const };
  } catch {
    return { readable: false as const, present: true as const };
  }
};

const isLegacyConfigVersion = (version: number | undefined): version is 4 | 5 =>
  version === LEGACY_SUBAGENT_CONFIG_VERSION || version === PREVIOUS_SUBAGENT_CONFIG_VERSION;

export const decodeProfileCandidate = <ValueInput>(
  value: ValueInput,
  version = SUBAGENT_CONFIG_VERSION,
): ProfileCandidate | undefined => {
  const record = decodedRecord(value);
  const priorityKey = isLegacyConfigVersion(version) ? "fastMode" : "openaiFastMode";
  const allowedKeys = new Set<string>([...CANDIDATE_BASE_KEYS, priorityKey]);
  if (!record || !ownKeysAre(record, allowedKeys)) return undefined;
  const host = readCandidateField(record, "host");
  const runtime = readCandidateField(record, "runtime");
  const model = readCandidateField(record, "model");
  const effort = readCandidateField(record, "effort");
  const context = readCandidateField(record, "context");
  const writeIntent = readCandidateField(record, "writeIntent");
  const openaiFastMode = readCandidateField(record, priorityKey);
  const closeOnReport = readCandidateField(record, "closeOnReport");
  if (
    !host.readable ||
    !host.present ||
    !runtime.readable ||
    !runtime.present ||
    !model.readable ||
    !model.present ||
    !effort.readable ||
    !effort.present ||
    !context.readable ||
    !context.present ||
    !writeIntent.readable ||
    !writeIntent.present ||
    !openaiFastMode.readable ||
    !closeOnReport.readable
  )
    return undefined;
  const plain = {
    host: host.value,
    runtime: runtime.value,
    model: model.value,
    effort: effort.value,
    context: context.value,
    writeIntent: writeIntent.value,
    ...(openaiFastMode.present && { openaiFastMode: openaiFastMode.value }),
    ...(closeOnReport.present && { closeOnReport: closeOnReport.value }),
  };
  try {
    const decoded = Schema.decodeUnknownOption(CandidateContractSchema)(plain);
    if (Option.isNone(decoded)) return undefined;
    const candidate = normalizeProfileCandidate(decoded.value);
    return profileCandidateValidationIssues(candidate).length === 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
};

const decodeRoute = <ValueInput>(
  value: ValueInput,
  version: number,
  path: string,
  diagnostics: string[],
): DeclaredProfileRoute | undefined => {
  if (value === "disabled") return "disabled";
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    diagnostics.push(path);
    return undefined;
  }
  if (!isArray) {
    const candidate = decodeProfileCandidate(value, version);
    if (!candidate) diagnostics.push(path);
    return candidate;
  }
  // SAFETY: The guarded native Array check above established this hostile-input view.
  const values = value as ValueInput & ReadonlyArray<unknown>;
  let length: number;
  try {
    length = values.length;
  } catch {
    diagnostics.push(path);
    return undefined;
  }
  if (length === 0 || length > MAX_PROFILE_CANDIDATES) {
    diagnostics.push(
      length > MAX_PROFILE_CANDIDATES ? `${path}[${MAX_PROFILE_CANDIDATES}+]` : path,
    );
    return undefined;
  }
  const candidates: ProfileCandidate[] = [];
  let invalid = false;
  for (let index = 0; index < length; index += 1) {
    let item: unknown;
    try {
      item = values[index];
    } catch {
      diagnostics.push(`${path}[${index}]`);
      invalid = true;
      continue;
    }
    const candidate = decodeProfileCandidate(item, version);
    if (!candidate) {
      diagnostics.push(`${path}[${index}]`);
      invalid = true;
    } else candidates.push(candidate);
  }
  return invalid ? undefined : candidates;
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

const decodeProfileSets = <ValueInput>(
  value: ValueInput,
  version: number,
  path: string,
  diagnostics: string[],
):
  | {
      readonly sets: Record<string, SubagentProfileSet>;
      readonly invalidRoutes: Record<string, ReadonlyArray<ProfileId>>;
      readonly invalidSets: ReadonlyArray<string>;
    }
  | undefined => {
  const record = decodedRecord(value);
  if (!record) {
    diagnostics.push(path);
    return undefined;
  }
  const names = safeOwnKeys(record);
  if (!names) {
    diagnostics.push(path);
    return undefined;
  }
  if (names.length > MAX_PROFILE_SETS) {
    diagnostics.push(`${path}[${MAX_PROFILE_SETS}+]`);
    return undefined;
  }
  // SAFETY: These null-prototype maps are populated only with validated set names below.
  const sets = Object.create(null) as Record<string, SubagentProfileSet>;
  // SAFETY: This null-prototype map is populated only with validated set names below.
  const invalidRoutes = Object.create(null) as Record<string, ReadonlyArray<ProfileId>>;
  const invalidSets: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    const setPath = `${path}[${index}]`;
    if (!isProfileSetName(name)) {
      diagnostics.push(`${setPath}.name`);
      continue;
    }
    const field = readField(record, name, setPath, diagnostics);
    const setRecord = field.present ? decodedRecord(field.value) : undefined;
    if (!setRecord || !ownKeysAre(setRecord, SET_KEYS)) {
      diagnostics.push(setPath);
      invalidSets.push(name);
      continue;
    }
    const profilesField = readField(setRecord, "profiles", `${setPath}.profiles`, diagnostics);
    if (!profilesField.present) {
      diagnostics.push(`${setPath}.profiles`);
      invalidSets.push(name);
      continue;
    }
    const decoded = decodeProfiles(
      profilesField.value,
      version,
      `${setPath}.profiles`,
      diagnostics,
    );
    if (!decoded) {
      invalidSets.push(name);
      continue;
    }
    sets[name] = { profiles: decoded.profiles };
    if (decoded.invalidRoutes.length > 0) invalidRoutes[name] = decoded.invalidRoutes;
  }
  return { sets, invalidRoutes, invalidSets };
};

const ConfigVersionSchema = Schema.Literals([
  LEGACY_SUBAGENT_CONFIG_VERSION,
  PREVIOUS_SUBAGENT_CONFIG_VERSION,
  SUBAGENT_CONFIG_VERSION,
]);

const decodeConfigVersion = <ValueInput>(value: ValueInput): 4 | 5 | 6 | undefined => {
  const decoded = Schema.decodeUnknownOption(ConfigVersionSchema)(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const decodeProfileSetName = <ValueInput>(value: ValueInput): string | undefined => {
  const decoded = Schema.decodeUnknownOption(Schema.String)(value);
  if (Option.isNone(decoded) || !isProfileSetName(decoded.value)) return undefined;
  return decoded.value;
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
  const versionField = readField(rawRoot, "version", `${scope}.version`, diagnostics);
  const version = decodeConfigVersion(versionField.value);
  const supported = version !== undefined;
  const allowedRootKeys =
    version === LEGACY_SUBAGENT_CONFIG_VERSION
      ? new Set(["version", "profiles"])
      : version === PREVIOUS_SUBAGENT_CONFIG_VERSION
        ? new Set(["version", "profiles", "nesting"])
        : new Set(["version", "defaultProfileSet", "profileSets", "nesting"]);
  if (!ownKeysAre(rawRoot, allowedRootKeys)) diagnostics.push(`${scope}.<unknown>`);

  let file: SubagentConfigFile = supported ? { version } : {};
  // SAFETY: This null-prototype map is populated only by bounded profile decoders.
  const invalidProfileSetRoutes = Object.create(null) as Record<string, ReadonlyArray<ProfileId>>;
  let invalidProfileSets: ReadonlyArray<string> = [];
  let invalidDefaultProfileSet = false;

  if (isLegacyConfigVersion(version)) {
    const profilesField = readField(rawRoot, "profiles", `${scope}.profiles`, diagnostics);
    if (profilesField.present) {
      const decoded = decodeProfiles(
        profilesField.value,
        version,
        `${scope}.profiles`,
        diagnostics,
      );
      if (decoded) {
        const profileSet: SubagentProfileSet = { profiles: decoded.profiles };
        file = {
          ...file,
          defaultProfileSet: MIGRATED_PROFILE_SET_NAME,
          profileSets: { [MIGRATED_PROFILE_SET_NAME]: profileSet },
        };
        if (decoded.invalidRoutes.length > 0)
          invalidProfileSetRoutes[MIGRATED_PROFILE_SET_NAME] = decoded.invalidRoutes;
      }
    }
  } else if (version === SUBAGENT_CONFIG_VERSION) {
    const setsField = readField(rawRoot, "profileSets", `${scope}.profileSets`, diagnostics);
    if (setsField.present) {
      const decoded = decodeProfileSets(
        setsField.value,
        version,
        `${scope}.profileSets`,
        diagnostics,
      );
      if (decoded) {
        if (Object.keys(decoded.sets).length > 0) file = { ...file, profileSets: decoded.sets };
        Object.assign(invalidProfileSetRoutes, decoded.invalidRoutes);
        invalidProfileSets = decoded.invalidSets;
      }
    }
    const defaultField = readField(
      rawRoot,
      "defaultProfileSet",
      `${scope}.defaultProfileSet`,
      diagnostics,
    );
    if (defaultField.present) {
      const defaultName = decodeProfileSetName(defaultField.value);
      if (defaultName === undefined) {
        diagnostics.push(`${scope}.defaultProfileSet`);
        invalidDefaultProfileSet = true;
      } else {
        file = { ...file, defaultProfileSet: defaultName };
      }
    }
  }

  const nestingField = readField(rawRoot, "nesting", `${scope}.nesting`, diagnostics);
  const nesting =
    (version === PREVIOUS_SUBAGENT_CONFIG_VERSION || version === SUBAGENT_CONFIG_VERSION) &&
    nestingField.present
      ? decodeSubagentNesting(nestingField.value)
      : undefined;
  if (
    (version === PREVIOUS_SUBAGENT_CONFIG_VERSION || version === SUBAGENT_CONFIG_VERSION) &&
    nestingField.present &&
    nesting === undefined
  )
    diagnostics.push(`${scope}.nesting`);
  if (nesting !== undefined) file = { ...file, nesting };

  const defaultName = file.defaultProfileSet;
  if (
    defaultName !== undefined &&
    (!file.profileSets ||
      !Object.prototype.hasOwnProperty.call(file.profileSets, defaultName) ||
      invalidProfileSets.includes(defaultName))
  ) {
    invalidDefaultProfileSet = true;
    diagnostics.push(`${scope}.defaultProfileSet`);
  }
  const invalidProfileRoutes = defaultName ? (invalidProfileSetRoutes[defaultName] ?? []) : [];
  const unsupportedVersion = !supported;
  if (unsupportedVersion) diagnostics.push(`${scope}.version`);

  return {
    file,
    diagnostics: [...new Set(diagnostics)],
    invalidProfileSetRoutes,
    invalidProfileSets,
    invalidDefaultProfileSet,
    invalidProfileRoutes,
    unsupportedVersion,
  };
}
