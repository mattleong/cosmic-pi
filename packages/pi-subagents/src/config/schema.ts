import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PROFILE_IDS,
  type ModelPolicySelector,
  type ProfileCandidate,
  type ProfileFallback,
  type ProfileId,
  type ProfileRoute,
} from "../profiles/model.ts";

export const SUBAGENT_CONFIG_BASENAME = "pi-subagents.json";
export const SUBAGENT_CONFIG_VERSION = 1;
export const MAX_POLICY_SELECTORS = 256;
export const MAX_PROFILE_CANDIDATES = 32;
export const MAX_MODEL_SELECTOR_CHARS = 256;

export interface SubagentConfigFile {
  readonly version?: number | undefined;
  readonly defaultProfile?: ProfileId | undefined;
  readonly denied?: ReadonlyArray<ModelPolicySelector> | undefined;
  readonly discouraged?: ReadonlyArray<ModelPolicySelector> | undefined;
  readonly profiles?: Partial<Readonly<Record<ProfileId, ProfileRoute>>> | undefined;
}

export interface DecodedSubagentConfig {
  readonly file: SubagentConfigFile;
  /** Redacted structural paths only; values and parser details are never retained. */
  readonly diagnostics: ReadonlyArray<string>;
  /** True when the document declares a version other than SUBAGENT_CONFIG_VERSION. */
  readonly unsupportedVersion: boolean;
}

export const ProfileIdSchema = Schema.Literals(PROFILE_IDS);
export const ProfileFallbackSchema = Schema.Literals(["fail", "parent"] as const);
export const ProfileBackendSchema = Schema.Literals(["pi", "claude-cli"] as const);
export const ProfileEffortSchema = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);

const hasNoTerminalControls = Schema.makeFilter((value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
});
const NonEmptyStringSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_MODEL_SELECTOR_CHARS),
  Schema.isPattern(/\S/),
  hasNoTerminalControls,
);
export const ModelPolicySelectorSchema = Schema.Struct({
  backend: ProfileBackendSchema,
  model: NonEmptyStringSchema,
});
const ModelCandidateSchema = Schema.Struct({
  source: Schema.Literal("model"),
  backend: ProfileBackendSchema,
  model: NonEmptyStringSchema,
  effort: Schema.optional(ProfileEffortSchema),
});
const ParentCandidateSchema = Schema.Struct({ source: Schema.Literal("parent") });
export const ProfileCandidateSchema = Schema.Union([ModelCandidateSchema, ParentCandidateSchema]);

const ownKeysAre = (
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean => {
  try {
    return Object.keys(record).every((key) => allowed.has(key));
  } catch {
    return false;
  }
};

// Configuration arrives from parsed JSON, but this boundary deliberately performs no recursive
// Schema record decode before hostile arrays have been capped.
const decodedRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const readField = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  diagnostics: string[],
): { readonly present: boolean; readonly value?: unknown } => {
  try {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false };
    return { present: true, value: record[key] };
  } catch {
    diagnostics.push(path);
    return { present: true };
  }
};

const decodeField = <A>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  schema: Schema.Decoder<A>,
  path: string,
  diagnostics: string[],
): A | undefined => {
  const field = readField(record, key, path, diagnostics);
  if (!field.present) return undefined;
  const decoded = Schema.decodeUnknownOption(schema)(field.value);
  if (Option.isNone(decoded)) {
    diagnostics.push(path);
    return undefined;
  }
  return decoded.value;
};

const normalizedSelector = (selector: ModelPolicySelector): ModelPolicySelector => ({
  backend: selector.backend,
  model: selector.model.trim(),
});

const normalizedCandidate = (candidate: ProfileCandidate): ProfileCandidate =>
  candidate.source === "parent"
    ? candidate
    : {
        ...candidate,
        model: candidate.model.trim(),
      };

const decodeArrayItems = <A>(
  value: unknown,
  schema: Schema.Decoder<A>,
  path: string,
  diagnostics: string[],
  normalize: (value: A) => A,
  maximum: number,
  allowedKeys: (record: Readonly<Record<string, unknown>>) => ReadonlySet<string>,
): ReadonlyArray<A> => {
  if (!Array.isArray(value)) {
    if (value !== undefined) diagnostics.push(path);
    return [];
  }
  if (value.length > maximum) diagnostics.push(`${path}[${maximum}+]`);
  // Index only the bounded prefix. Array.prototype/schema transforms can inspect every element or
  // invoke species accessors before a later slice, defeating the boundary.
  const decodedItems: A[] = [];
  for (let index = 0; index < Math.min(value.length, maximum); index += 1) {
    let item: unknown;
    try {
      item = value[index];
    } catch {
      diagnostics.push(`${path}[${index}]`);
      continue;
    }
    const record = decodedRecord(item);
    if (!record || !ownKeysAre(record, allowedKeys(record))) {
      diagnostics.push(`${path}[${index}]`);
      continue;
    }
    const decoded = Schema.decodeUnknownOption(schema)(record);
    if (Option.isNone(decoded)) {
      diagnostics.push(`${path}[${index}]`);
      continue;
    }
    decodedItems.push(normalize(decoded.value));
  }
  return decodedItems;
};

const SELECTOR_KEYS = new Set(["backend", "model"]);
const MODEL_CANDIDATE_KEYS = new Set(["source", "backend", "model", "effort"]);
const PARENT_CANDIDATE_KEYS = new Set(["source"]);
const selectorKeys = () => SELECTOR_KEYS;
const candidateKeys = (record: Readonly<Record<string, unknown>>) =>
  record.source === "parent" ? PARENT_CANDIDATE_KEYS : MODEL_CANDIDATE_KEYS;

const decodeRoute = (
  value: unknown,
  path: string,
  diagnostics: string[],
): ProfileRoute | undefined => {
  const record = decodedRecord(value);
  if (!record) {
    diagnostics.push(path);
    return undefined;
  }
  if (!ownKeysAre(record, new Set(["candidates", "fallback"])))
    diagnostics.push(`${path}.<unknown>`);
  const candidatesField = readField(record, "candidates", `${path}.candidates`, diagnostics);
  const fallback = decodeField(
    record,
    "fallback",
    ProfileFallbackSchema,
    `${path}.fallback`,
    diagnostics,
  );
  const candidates = decodeArrayItems(
    candidatesField.value,
    ProfileCandidateSchema,
    `${path}.candidates`,
    diagnostics,
    normalizedCandidate,
    MAX_PROFILE_CANDIDATES,
    candidateKeys,
  );
  return {
    candidates,
    // A configured route never gains an implicit parent fallback.
    fallback: (fallback ?? "fail") as ProfileFallback,
  };
};

/** Field- and item-tolerant unknown-boundary decode for one global or project document. */
export function decodeSubagentConfig(input: unknown, scope = "config"): DecodedSubagentConfig {
  const diagnostics: string[] = [];
  const decodedRoot = decodedRecord(input);
  const rawRoot = decodedRoot ?? {};
  if (!decodedRoot) diagnostics.push(scope);
  if (
    !ownKeysAre(
      rawRoot,
      new Set(["version", "defaultProfile", "denied", "discouraged", "profiles"]),
    )
  )
    diagnostics.push(`${scope}.<unknown>`);

  const versionField = readField(rawRoot, "version", `${scope}.version`, diagnostics);
  const defaultProfile = decodeField(
    rawRoot,
    "defaultProfile",
    ProfileIdSchema,
    `${scope}.defaultProfile`,
    diagnostics,
  );
  const deniedField = readField(rawRoot, "denied", `${scope}.denied`, diagnostics);
  const discouragedField = readField(rawRoot, "discouraged", `${scope}.discouraged`, diagnostics);
  const profilesField = readField(rawRoot, "profiles", `${scope}.profiles`, diagnostics);

  const denied = decodeArrayItems(
    deniedField.value,
    ModelPolicySelectorSchema,
    `${scope}.denied`,
    diagnostics,
    normalizedSelector,
    MAX_POLICY_SELECTORS,
    selectorKeys,
  );
  const discouraged = decodeArrayItems(
    discouragedField.value,
    ModelPolicySelectorSchema,
    `${scope}.discouraged`,
    diagnostics,
    normalizedSelector,
    MAX_POLICY_SELECTORS,
    selectorKeys,
  );
  const decodedProfiles = decodedRecord(profilesField.value);
  if (profilesField.present && !decodedProfiles) diagnostics.push(`${scope}.profiles`);
  const profileRecord = decodedProfiles ?? {};
  const profiles: Partial<Record<ProfileId, ProfileRoute>> = {};
  for (const id of PROFILE_IDS) {
    const field = readField(profileRecord, id, `${scope}.profiles.${id}`, diagnostics);
    if (!field.present) continue;
    const route = decodeRoute(field.value, `${scope}.profiles.${id}`, diagnostics);
    if (route) profiles[id] = route;
  }
  if (!ownKeysAre(profileRecord, new Set<string>(PROFILE_IDS)))
    diagnostics.push(`${scope}.profiles.<unknown>`);

  // Presence is semantic: malformed, null, boolean, string, and fractional declarations all
  // fail activation closed rather than being recovered as an ordinary field typo.
  const version = versionField.value;
  const unsupportedVersion = versionField.present && versionField.value !== SUBAGENT_CONFIG_VERSION;
  if (unsupportedVersion) diagnostics.push(`${scope}.version`);

  return {
    file: {
      ...(version === SUBAGENT_CONFIG_VERSION ? { version } : {}),
      ...(defaultProfile ? { defaultProfile } : {}),
      ...(denied.length > 0 ? { denied } : {}),
      ...(discouraged.length > 0 ? { discouraged } : {}),
      ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    },
    diagnostics: [...new Set(diagnostics)],
    unsupportedVersion,
  };
}
