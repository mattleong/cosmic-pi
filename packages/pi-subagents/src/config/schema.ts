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
export const SUBAGENT_CONFIG_VERSION = 4;

export interface SubagentConfigFile {
  readonly version?: number | undefined;
  readonly profiles?: Partial<Readonly<Record<ProfileId, DeclaredProfileRoute>>> | undefined;
}

export interface DecodedSubagentConfig {
  readonly file: SubagentConfigFile;
  /** Redacted structural paths only; values and parser details are never retained. */
  readonly diagnostics: ReadonlyArray<string>;
  readonly invalidProfileRoutes: ReadonlyArray<ProfileId>;
  readonly unsupportedVersion: boolean;
}

export const ProfileHostSchema = Schema.Literals(PROFILE_CANDIDATE_HOSTS);
export const ProfileRuntimeSchema = Schema.Literals(PROFILE_CANDIDATE_RUNTIMES);
export const ProfileEffortSchema = Schema.Literals(PROFILE_CANDIDATE_EFFORTS);
export const ProfileContextSchema = Schema.Literals(PROFILE_CANDIDATE_CONTEXTS);
export const ProfileWriteIntentSchema = Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS);

const CANDIDATE_KEYS = [
  "host",
  "runtime",
  "model",
  "effort",
  "context",
  "writeIntent",
  "fastMode",
  "closeOnReport",
] as const;
const CANDIDATE_KEYS_SET = new Set<string>(CANDIDATE_KEYS);
const CandidateContractSchema = Schema.Struct({
  host: ProfileHostSchema,
  runtime: ProfileRuntimeSchema,
  model: Schema.String,
  effort: ProfileEffortSchema,
  context: ProfileContextSchema,
  writeIntent: ProfileWriteIntentSchema,
  fastMode: Schema.optional(Schema.Boolean),
  closeOnReport: Schema.optional(Schema.Boolean),
});

const ownKeysAre = (record: Readonly<JsonObject>, allowed: ReadonlySet<string>): boolean => {
  try {
    return Object.keys(record).every((key) => allowed.has(key));
  } catch {
    return false;
  }
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
    if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false };
    return { present: true, value: record[key] };
  } catch {
    diagnostics.push(path);
    return { present: true };
  }
};

const readCandidateField = (record: Readonly<JsonObject>, key: (typeof CANDIDATE_KEYS)[number]) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(record, key))
      return { readable: true as const, present: false as const };
    return { readable: true as const, present: true as const, value: record[key] };
  } catch {
    return { readable: false as const, present: true as const };
  }
};

export const decodeProfileCandidate = <ValueInput>(
  value: ValueInput,
): ProfileCandidate | undefined => {
  const record = decodedRecord(value);
  if (!record || !ownKeysAre(record, CANDIDATE_KEYS_SET)) return undefined;
  const host = readCandidateField(record, "host");
  const runtime = readCandidateField(record, "runtime");
  const model = readCandidateField(record, "model");
  const effort = readCandidateField(record, "effort");
  const context = readCandidateField(record, "context");
  const writeIntent = readCandidateField(record, "writeIntent");
  const fastMode = readCandidateField(record, "fastMode");
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
    !fastMode.readable ||
    !closeOnReport.readable
  )
    return undefined;
  const base = {
    host: host.value,
    runtime: runtime.value,
    model: model.value,
    effort: effort.value,
    context: context.value,
    writeIntent: writeIntent.value,
  };
  const withFastMode = fastMode.present ? { ...base, fastMode: fastMode.value } : base;
  const plain = closeOnReport.present
    ? { ...withFastMode, closeOnReport: closeOnReport.value }
    : withFastMode;
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
    const candidate = decodeProfileCandidate(value);
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
    const candidate = decodeProfileCandidate(item);
    if (!candidate) {
      diagnostics.push(`${path}[${index}]`);
      invalid = true;
    } else candidates.push(candidate);
  }
  return invalid ? undefined : candidates;
};

/** Strict version-4 unknown-boundary decode for one global or project document. */
export function decodeSubagentConfig<InputInput>(
  input: InputInput,
  scope = "config",
): DecodedSubagentConfig {
  const diagnostics: string[] = [];
  const decodedRoot = decodedRecord(input);
  const rawRoot = decodedRoot ?? {};
  if (!decodedRoot) diagnostics.push(scope);
  if (!ownKeysAre(rawRoot, new Set(["version", "profiles"])))
    diagnostics.push(`${scope}.<unknown>`);

  const versionField = readField(rawRoot, "version", `${scope}.version`, diagnostics);
  const profilesField = readField(rawRoot, "profiles", `${scope}.profiles`, diagnostics);
  const decodedProfiles = decodedRecord(profilesField.value);
  if (profilesField.present && !decodedProfiles) diagnostics.push(`${scope}.profiles`);
  const profileRecord = decodedProfiles ?? {};
  const profiles: Partial<Record<ProfileId, DeclaredProfileRoute>> = {};
  const invalidProfileRoutes: ProfileId[] = [];
  for (const id of PROFILE_IDS) {
    const path = `${scope}.profiles.${id}`;
    const field = readField(profileRecord, id, path, diagnostics);
    if (!field.present) continue;
    const route = decodeRoute(field.value, path, diagnostics);
    if (route === undefined) invalidProfileRoutes.push(id);
    else profiles[id] = route;
  }
  if (!ownKeysAre(profileRecord, new Set<string>(PROFILE_IDS)))
    diagnostics.push(`${scope}.profiles.<unknown>`);

  const version = versionField.value;
  const unsupportedVersion = version !== SUBAGENT_CONFIG_VERSION;
  if (unsupportedVersion) diagnostics.push(`${scope}.version`);

  let file: SubagentConfigFile = {};
  if (version === SUBAGENT_CONFIG_VERSION) file = { version };
  if (Object.keys(profiles).length > 0) file = { ...file, profiles };
  return {
    file,
    diagnostics: [...new Set(diagnostics)],
    invalidProfileRoutes,
    unsupportedVersion,
  };
}
