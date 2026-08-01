import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  LEGACY_PROFILE_ID,
  PROFILE_CANDIDATE_EFFORTS,
  PROFILE_IDS,
  PROFILE_INPUT_IDS,
  type DeclaredProfileRoute,
  type ProfileCandidate,
  type ProfileId,
} from "../profiles/model.ts";
import { supportsSubagentFastMode } from "../run/fast-mode.ts";
import { subagentRuntimeSupportsEffort } from "../run/model.ts";
import {
  isSafeNativeModelSelector,
  MAX_NATIVE_MODEL_SELECTOR_CHARS,
} from "../run/native-model-selector.ts";
export const SUBAGENT_CONFIG_BASENAME = "pi-subagents.json";
export const SUBAGENT_CONFIG_VERSION = 4;
export const MAX_PROFILE_CANDIDATES = 32;
export const MAX_MODEL_SELECTOR_CHARS = MAX_NATIVE_MODEL_SELECTOR_CHARS;

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
  readonly legacyVersion3: boolean;
}

export const ProfileIdSchema = Schema.Literals(PROFILE_INPUT_IDS);
export const ProfileHostSchema = Schema.Literals(["local", "herdr"] as const);
export const ProfileRuntimeSchema = Schema.Literals(["pi", "claude", "codex"] as const);
export const ProfileEffortSchema = Schema.Literals(PROFILE_CANDIDATE_EFFORTS);
export const ProfileContextSchema = Schema.Literals(["fresh", "fork"] as const);
export const ProfileWriteIntentSchema = Schema.Literals(["read-only", "writer"] as const);

const containsNoTerminalControls = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
};
const hasNoTerminalControls = Schema.makeFilter(containsNoTerminalControls);
const NativeModelSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_MODEL_SELECTOR_CHARS),
  Schema.isPattern(/\S/),
  hasNoTerminalControls,
);
const CandidateShapeSchema = Schema.Struct({
  host: ProfileHostSchema,
  runtime: ProfileRuntimeSchema,
  model: NativeModelSchema,
  effort: ProfileEffortSchema,
  context: ProfileContextSchema,
  writeIntent: ProfileWriteIntentSchema,
  fastMode: Schema.optional(Schema.Boolean),
  closeOnReport: Schema.optional(Schema.Boolean),
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

/** Syntax-only native selector validation. Catalog availability remains a launch-time boundary. */
export const isNativeProfileModelSelector = (runtime: string, selector: string): boolean => {
  const value = selector;
  if (!isSafeNativeModelSelector(value)) return false;
  if (value === "parent") return runtime === "pi";
  if (runtime !== "pi") return true;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1 || /\s/.test(value)) return false;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model) &&
    model.split("/").every((segment) => segment !== "." && segment !== ".." && segment.length > 0)
  );
};

/** Compatibility name retained for callers validating Pi-native selectors. */
export const isCanonicalProfileModelSelector = (selector: string): boolean =>
  isNativeProfileModelSelector("pi", selector);

const decodeCandidate = (value: unknown): ProfileCandidate | undefined => {
  const record = decodedRecord(value);
  if (
    !record ||
    !ownKeysAre(
      record,
      new Set([
        "host",
        "runtime",
        "model",
        "effort",
        "context",
        "writeIntent",
        "fastMode",
        "closeOnReport",
      ]),
    )
  )
    return undefined;
  const decoded = Schema.decodeUnknownOption(CandidateShapeSchema)(record);
  if (Option.isNone(decoded)) return undefined;
  const candidate = decoded.value;
  const model = candidate.model;
  const fastMode = candidate.fastMode ?? false;
  const closeOnReport = candidate.closeOnReport ?? true;
  if (!isNativeProfileModelSelector(candidate.runtime, model)) return undefined;
  if (
    candidate.effort !== "default" &&
    !subagentRuntimeSupportsEffort(candidate.runtime, candidate.effort)
  )
    return undefined;
  if (model === "parent" && (candidate.host !== "local" || candidate.runtime !== "pi"))
    return undefined;
  if (candidate.context === "fork" && (candidate.host !== "local" || candidate.runtime !== "pi"))
    return undefined;
  if (!closeOnReport && (candidate.host !== "herdr" || candidate.writeIntent !== "read-only"))
    return undefined;
  if (fastMode && model !== "parent" && !supportsSubagentFastMode(candidate.runtime, model))
    return undefined;
  return { ...candidate, model, fastMode, closeOnReport };
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

/** Field-tolerant v4 unknown-boundary decode for one global or project document. */
export function decodeSubagentConfig(input: unknown, scope = "config"): DecodedSubagentConfig {
  const diagnostics: string[] = [];
  const decodedRoot = decodedRecord(input);
  const rawRoot = decodedRoot ?? {};
  if (!decodedRoot) diagnostics.push(scope);
  if (!ownKeysAre(rawRoot, new Set(["version", "defaultProfile", "profiles"])))
    diagnostics.push(`${scope}.<unknown>`);

  const versionField = readField(rawRoot, "version", `${scope}.version`, diagnostics);
  // `defaultProfile` is accepted as a deprecated no-op and removed on the next settings write.
  readField(rawRoot, "defaultProfile", `${scope}.defaultProfile`, diagnostics);
  const profilesField = readField(rawRoot, "profiles", `${scope}.profiles`, diagnostics);
  const decodedProfiles = decodedRecord(profilesField.value);
  if (profilesField.present && !decodedProfiles) diagnostics.push(`${scope}.profiles`);
  const profileRecord = decodedProfiles ?? {};
  const profiles: Partial<Record<ProfileId, DeclaredProfileRoute>> = {};
  const invalidProfileRoutes: ProfileId[] = [];
  for (const id of PROFILE_IDS) {
    const canonicalPath = `${scope}.profiles.${id}`;
    const canonicalField = readField(profileRecord, id, canonicalPath, diagnostics);
    const legacyPath = `${scope}.profiles.${LEGACY_PROFILE_ID}`;
    const legacyField =
      id === "generalist"
        ? readField(profileRecord, LEGACY_PROFILE_ID, legacyPath, diagnostics)
        : undefined;
    const field = canonicalField.present ? canonicalField : legacyField;
    if (!field?.present) continue;
    const route = decodeRoute(
      field.value,
      canonicalField.present ? canonicalPath : legacyPath,
      diagnostics,
    );
    if (route === undefined) invalidProfileRoutes.push(id);
    else profiles[id] = route;
  }
  if (!ownKeysAre(profileRecord, new Set<string>(PROFILE_INPUT_IDS)))
    diagnostics.push(`${scope}.profiles.<unknown>`);

  const version = versionField.value;
  const unsupportedVersion = version !== SUBAGENT_CONFIG_VERSION;
  if (unsupportedVersion) diagnostics.push(`${scope}.version`);

  return {
    file: {
      ...(version === SUBAGENT_CONFIG_VERSION ? { version } : {}),
      ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    },
    diagnostics: [...new Set(diagnostics)],
    invalidProfileRoutes,
    unsupportedVersion,
    legacyVersion3: version === 3,
  };
}
