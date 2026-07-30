import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PROFILE_CANDIDATE_EFFORTS,
  PROFILE_IDS,
  type DeclaredProfileRoute,
  type ModelPolicySelector,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
export const SUBAGENT_CONFIG_BASENAME = "pi-subagents.json";
export const SUBAGENT_CONFIG_VERSION = 3;
export const MAX_POLICY_SELECTORS = 256;
export const MAX_PROFILE_CANDIDATES = 32;
export const MAX_MODEL_SELECTOR_CHARS = 256;

export interface SubagentConfigFile {
  readonly version?: number | undefined;
  readonly defaultProfile?: ProfileId | undefined;
  readonly denied?: ReadonlyArray<ModelPolicySelector> | undefined;
  readonly discouraged?: ReadonlyArray<ModelPolicySelector> | undefined;
  readonly profiles?: Partial<Readonly<Record<ProfileId, DeclaredProfileRoute>>> | undefined;
}

export interface DecodedSubagentConfig {
  readonly file: SubagentConfigFile;
  /** Redacted structural paths only; values and parser details are never retained. */
  readonly diagnostics: ReadonlyArray<string>;
  readonly invalidProfileRoutes: ReadonlyArray<ProfileId>;
  readonly unsupportedVersion: boolean;
}

export const ProfileIdSchema = Schema.Literals(PROFILE_IDS);
export const ProfileBackendSchema = Schema.Literal("pi");
export const ProfileEffortSchema = Schema.Literals(PROFILE_CANDIDATE_EFFORTS);

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
const CandidateShapeSchema = Schema.Struct({
  model: NonEmptyStringSchema,
  effort: ProfileEffortSchema,
});

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

const decodePolicyItems = (
  value: unknown,
  path: string,
  diagnostics: string[],
): ReadonlyArray<ModelPolicySelector> => {
  if (!Array.isArray(value)) {
    if (value !== undefined) diagnostics.push(path);
    return [];
  }
  if (value.length > MAX_POLICY_SELECTORS) diagnostics.push(`${path}[${MAX_POLICY_SELECTORS}+]`);
  const result: ModelPolicySelector[] = [];
  for (let index = 0; index < Math.min(value.length, MAX_POLICY_SELECTORS); index += 1) {
    let item: unknown;
    try {
      item = value[index];
    } catch {
      diagnostics.push(`${path}[${index}]`);
      continue;
    }
    const record = decodedRecord(item);
    const decoded = record
      ? Schema.decodeUnknownOption(ModelPolicySelectorSchema)(record)
      : Option.none();
    if (!record || !ownKeysAre(record, new Set(["backend", "model"])) || Option.isNone(decoded)) {
      diagnostics.push(`${path}[${index}]`);
      continue;
    }
    result.push({ backend: decoded.value.backend, model: decoded.value.model.trim() });
  }
  return result;
};

/** Syntax-only canonical selector validation. Catalog availability remains a launch-time boundary. */
export const isCanonicalProfileModelSelector = (selector: string): boolean => {
  const value = selector.trim();
  if (value.length === 0 || value.length > MAX_MODEL_SELECTOR_CHARS) return false;
  if (value === "parent") return true;
  if (!value.startsWith("pi/")) return false;
  const canonical = value.slice(3);
  const slash = canonical.indexOf("/");
  if (slash <= 0 || slash >= canonical.length - 1 || /\s/.test(canonical)) return false;
  const provider = canonical.slice(0, slash);
  const model = canonical.slice(slash + 1);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model) &&
    model.split("/").every((segment) => segment !== "." && segment !== ".." && segment.length > 0)
  );
};

const decodeCandidate = (value: unknown): ProfileCandidate | undefined => {
  const record = decodedRecord(value);
  if (!record || !ownKeysAre(record, new Set(["model", "effort"]))) return undefined;
  const decoded = Schema.decodeUnknownOption(CandidateShapeSchema)(record);
  if (Option.isNone(decoded)) return undefined;
  const model = decoded.value.model.trim();
  return isCanonicalProfileModelSelector(model)
    ? { model, effort: decoded.value.effort }
    : undefined;
};

const decodeRoute = (
  value: unknown,
  path: string,
  diagnostics: string[],
): DeclaredProfileRoute | undefined => {
  if (value === "disabled") return value;
  if (!Array.isArray(value)) {
    const candidate = decodeCandidate(value);
    if (!candidate) diagnostics.push(path);
    return candidate;
  }
  if (value.length === 0 || value.length > MAX_PROFILE_CANDIDATES) {
    diagnostics.push(
      value.length > MAX_PROFILE_CANDIDATES ? `${path}[${MAX_PROFILE_CANDIDATES}+]` : path,
    );
    return undefined;
  }
  const candidates: ProfileCandidate[] = [];
  let invalid = false;
  for (let index = 0; index < Math.min(value.length, MAX_PROFILE_CANDIDATES); index += 1) {
    let item: unknown;
    try {
      item = value[index];
    } catch {
      diagnostics.push(`${path}[${index}]`);
      invalid = true;
      continue;
    }
    const candidate = decodeCandidate(item);
    if (!candidate) {
      diagnostics.push(`${path}[${index}]`);
      invalid = true;
    } else candidates.push(candidate);
  }
  return invalid ? undefined : candidates;
};

/** Field-tolerant v3 unknown-boundary decode for one global or project document. */
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
  const denied = decodePolicyItems(deniedField.value, `${scope}.denied`, diagnostics);
  const discouraged = decodePolicyItems(
    discouragedField.value,
    `${scope}.discouraged`,
    diagnostics,
  );

  const decodedProfiles = decodedRecord(profilesField.value);
  if (profilesField.present && !decodedProfiles) diagnostics.push(`${scope}.profiles`);
  const profileRecord = decodedProfiles ?? {};
  const profiles: Partial<Record<ProfileId, DeclaredProfileRoute>> = {};
  const invalidProfileRoutes: ProfileId[] = [];
  for (const id of PROFILE_IDS) {
    const field = readField(profileRecord, id, `${scope}.profiles.${id}`, diagnostics);
    if (!field.present) continue;
    const route = decodeRoute(field.value, `${scope}.profiles.${id}`, diagnostics);
    if (route === undefined) invalidProfileRoutes.push(id);
    else profiles[id] = route;
  }
  if (!ownKeysAre(profileRecord, new Set<string>(PROFILE_IDS)))
    diagnostics.push(`${scope}.profiles.<unknown>`);

  const version = versionField.value;
  const unsupportedVersion = version !== SUBAGENT_CONFIG_VERSION;
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
    invalidProfileRoutes,
    unsupportedVersion,
  };
}
