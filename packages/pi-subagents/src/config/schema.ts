import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeTolerantFields } from "pi-cosmic-core";
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

const UnknownArraySchema = Schema.Array(Schema.Unknown);
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

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
): ReadonlyArray<A> => {
  const array = Schema.decodeUnknownOption(UnknownArraySchema)(value);
  if (Option.isNone(array)) {
    if (value !== undefined) diagnostics.push(path);
    return [];
  }
  if (array.value.length > maximum) diagnostics.push(`${path}[${maximum}+]`);
  return array.value.slice(0, maximum).flatMap((item, index) => {
    const decoded = Schema.decodeUnknownOption(schema)(item);
    if (Option.isNone(decoded)) {
      diagnostics.push(`${path}[${index}]`);
      return [];
    }
    return [normalize(decoded.value)];
  });
};

const decodeRoute = (
  value: unknown,
  path: string,
  diagnostics: string[],
): ProfileRoute | undefined => {
  const record = Schema.decodeUnknownOption(UnknownRecordSchema)(value);
  if (Option.isNone(record)) {
    diagnostics.push(path);
    return undefined;
  }
  const fields = decodeTolerantFields(
    record.value,
    { candidates: UnknownArraySchema, fallback: ProfileFallbackSchema },
    { path },
  );
  diagnostics.push(...fields.diagnostics.map((diagnostic) => diagnostic.path));
  const candidates = decodeArrayItems(
    fields.value.candidates,
    ProfileCandidateSchema,
    `${path}.candidates`,
    diagnostics,
    normalizedCandidate,
    MAX_PROFILE_CANDIDATES,
  );
  return {
    candidates,
    // A configured route never gains an implicit parent fallback.
    fallback: (fields.value.fallback ?? "fail") as ProfileFallback,
  };
};

/** Field- and item-tolerant unknown-boundary decode for one global or project document. */
export function decodeSubagentConfig(input: unknown, scope = "config"): DecodedSubagentConfig {
  const diagnostics: string[] = [];
  const root = decodeTolerantFields(
    input,
    {
      version: Schema.Number,
      defaultProfile: ProfileIdSchema,
      denied: UnknownArraySchema,
      discouraged: UnknownArraySchema,
      profiles: UnknownRecordSchema,
    },
    { path: scope },
  );
  diagnostics.push(...root.diagnostics.map((diagnostic) => diagnostic.path));

  const denied = decodeArrayItems(
    root.value.denied,
    ModelPolicySelectorSchema,
    `${scope}.denied`,
    diagnostics,
    normalizedSelector,
    MAX_POLICY_SELECTORS,
  );
  const discouraged = decodeArrayItems(
    root.value.discouraged,
    ModelPolicySelectorSchema,
    `${scope}.discouraged`,
    diagnostics,
    normalizedSelector,
    MAX_POLICY_SELECTORS,
  );
  const profileRecord = root.value.profiles ?? {};
  const profiles: Partial<Record<ProfileId, ProfileRoute>> = {};
  for (const id of PROFILE_IDS) {
    if (!(id in profileRecord)) continue;
    const route = decodeRoute(profileRecord[id], `${scope}.profiles.${id}`, diagnostics);
    if (route) profiles[id] = route;
  }
  if (
    Object.keys(profileRecord).some((key) => !(PROFILE_IDS as ReadonlyArray<string>).includes(key))
  )
    diagnostics.push(`${scope}.profiles.<unknown>`);

  // A declared unknown version is a semantic mismatch, not field corruption: the caller must
  // fail activation closed instead of applying a partially understood policy document.
  const version = root.value.version;
  const unsupportedVersion = version !== undefined && version !== SUBAGENT_CONFIG_VERSION;
  if (unsupportedVersion) diagnostics.push(`${scope}.version`);

  return {
    file: {
      ...(version === SUBAGENT_CONFIG_VERSION ? { version } : {}),
      ...(root.value.defaultProfile ? { defaultProfile: root.value.defaultProfile } : {}),
      ...(denied.length > 0 ? { denied } : {}),
      ...(discouraged.length > 0 ? { discouraged } : {}),
      ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    },
    diagnostics: [...new Set(diagnostics)],
    unsupportedVersion,
  };
}
