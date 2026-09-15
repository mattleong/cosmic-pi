import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  freezeSnapshot,
  hasObjectRuntimeType,
  type JsonObject,
  type JsonValue,
} from "pi-cosmic-core";
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import {
  MAX_PROFILE_CANDIDATES,
  MAX_PROFILE_MODEL_SELECTOR_CHARS,
  PROFILE_CANDIDATE_CONTEXTS,
  PROFILE_CANDIDATE_EFFORTS,
  PROFILE_CANDIDATE_HOSTS,
  PROFILE_CANDIDATE_RUNTIMES,
  PROFILE_CANDIDATE_WRITE_INTENTS,
  PROFILE_IDS,
  profileCandidateValidationIssues,
  type ProfileCandidate,
} from "../profiles/model.ts";
import {
  MAX_PROTOCOL_ID_CHARS,
  MAX_START_BATCH,
  MAX_TARGET_RUNS,
  MAX_TOOL_OUTPUT_CHARS,
} from "../run/limits.ts";
import { MAX_WRITE_CLAIMS, MAX_WRITE_CLAIM_CHARS } from "../domain/write-claims.ts";
import { MAX_OBSERVED_WRITE_PATHS, MAX_WRITE_CLAIM_VIOLATIONS } from "../run/claims-observation.ts";
import {
  FAILED_START_CLEANUP_DISPOSITIONS,
  FAILED_START_RETRY_DISPOSITIONS,
  PI_SUBAGENT_CAPABILITIES,
  SUBAGENT_RUN_STATES,
} from "../run/model.ts";
import { MAX_ERROR_CHARS, MAX_FINAL_TEXT_CHARS, MAX_NAME_CHARS } from "../run/state.ts";

export const SUBAGENT_CARD_DETAILS_VERSION = 2;
export const MAX_CARD_MODEL_CHARS = 512;
export const MAX_CARD_PROVENANCE_CHARS = 1_024;
export const MAX_CARD_QUESTION_CHARS = 2_048;
export const MAX_CARD_SKIPS = 8;

const MAX_PROFILE_DESCRIPTION_CHARS = 512;
const MAX_PROFILE_CANDIDATE_REASON_CHARS = 1_024;
export const MAX_PROFILE_CHARS = 64;
export const MAX_ACTION_FAILURE_ID_CHARS = 128;
export const MAX_ACTION_FAILURE_CODE_CHARS = 64;
export const MAX_ACTION_FAILURE_MESSAGE_CHARS = 256;
export const MAX_FAILURE_CODE_CHARS = 128;
export const MAX_FAILURE_MESSAGE_CHARS = 512;
const MAX_CURRENT_TOOL_CHARS = 256;
const MAX_PROGRESS_CHARS = 512;
const MAX_WARNING_CHARS = 512;
const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;

const boundedString = (maximum: number, minimum = 0) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const nonNegativeNumber = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MAX_SAFE_NUMBER),
);
const nonNegativeInteger = nonNegativeNumber.check(Schema.isInt());

/** Workspace history keeps receipt metadata only, never immutable patch bodies. */
export const WorkspaceToolDetailsSchema = Schema.Struct({
  version: Schema.Literal(1),
  action: Schema.Literal("workspace"),
  operation: Schema.Literals(["list", "review", "prepare", "integrate", "discard", "revise"]),
  workspaceId: Schema.optionalKey(boundedString(MAX_PROTOCOL_ID_CHARS, 1)),
  revisionId: Schema.optionalKey(boundedString(MAX_PROTOCOL_ID_CHARS, 1)),
  preparationId: Schema.optionalKey(boundedString(MAX_PROTOCOL_ID_CHARS, 1)),
  offset: Schema.optionalKey(nonNegativeInteger),
  totalChars: Schema.optionalKey(nonNegativeInteger),
  nextOffset: Schema.optionalKey(nonNegativeInteger),
  workspaceCount: Schema.optionalKey(nonNegativeInteger),
  listedCount: Schema.optionalKey(nonNegativeInteger),
  preparedCwd: Schema.optionalKey(boundedString(1_024, 1)),
  successorRunId: Schema.optionalKey(boundedString(MAX_PROTOCOL_ID_CHARS, 1)),
});
export type WorkspaceToolDetails = typeof WorkspaceToolDetailsSchema.Type;
const boundedArray = <S extends Schema.Constraint>(schema: S, maximum: number) =>
  Schema.Array(schema).check(Schema.isMaxLength(maximum));

const HostSchema = Schema.Literals(PROFILE_CANDIDATE_HOSTS);
const RuntimeSchema = Schema.Literals(PROFILE_CANDIDATE_RUNTIMES);
const EffortSchema = Schema.Literals(SUBAGENT_EFFORTS);
const CandidateEffortSchema = Schema.Literals(PROFILE_CANDIDATE_EFFORTS);
const ContextSchema = Schema.Literals(PROFILE_CANDIDATE_CONTEXTS);
const WriteIntentSchema = Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS);
const ProfileIdSchema = Schema.Literals(PROFILE_IDS);
const ProfileSourceSchema = Schema.Literals([
  "session",
  "project",
  "project-invalid",
  "global",
  "global-invalid",
  "builtin",
] as const);

const UsageSchema = Schema.Struct({
  input: nonNegativeNumber,
  output: nonNegativeNumber,
  cacheRead: nonNegativeNumber,
  cacheWrite: nonNegativeNumber,
  totalTokens: nonNegativeNumber,
  cost: Schema.optionalKey(nonNegativeNumber),
});

const SkippedCandidateSchema = Schema.Struct({
  candidate: boundedString(MAX_CARD_PROVENANCE_CHARS, 1),
  code: boundedString(MAX_FAILURE_CODE_CHARS, 1),
  reason: boundedString(MAX_CARD_PROVENANCE_CHARS, 1),
});

const SelectionSchema = Schema.Struct({
  source: Schema.Literals(["profile-candidate", "profile-parent-candidate"] as const),
  candidateIndex: Schema.optionalKey(nonNegativeInteger),
  reason: boundedString(MAX_CARD_PROVENANCE_CHARS, 1),
  skippedCandidates: boundedArray(SkippedCandidateSchema, MAX_CARD_SKIPS),
  warning: Schema.optionalKey(boundedString(MAX_CARD_PROVENANCE_CHARS, 1)),
});

const WriteClaimViolationSchema = Schema.Struct({
  path: boundedString(MAX_WRITE_CLAIM_CHARS, 1),
  toolName: boundedString(200, 1),
  observedAt: nonNegativeNumber,
});

const WriteAuditSchema = Schema.Struct({
  observedFileWrites: boundedArray(
    boundedString(MAX_WRITE_CLAIM_CHARS, 1),
    MAX_OBSERVED_WRITE_PATHS,
  ),
  violations: boundedArray(WriteClaimViolationSchema, MAX_WRITE_CLAIM_VIOLATIONS),
  bashWriteHints: nonNegativeInteger,
});

const WorkspaceCardFields = {
  writerWorkspaceMode: Schema.optionalKey(Schema.Literals(["worktree", "shared-checkout"])),
  workspaceId: Schema.optionalKey(boundedString(MAX_PROTOCOL_ID_CHARS, 1)),
  cwd: Schema.optionalKey(boundedString(1_024, 1)),
  sourceCwd: Schema.optionalKey(boundedString(1_024, 1)),
};

export const SubagentRunCardSchema = Schema.Struct({
  ...WorkspaceCardFields,
  id: boundedString(MAX_PROTOCOL_ID_CHARS, 1),
  name: boundedString(MAX_NAME_CHARS, 1),
  state: Schema.Literals(SUBAGENT_RUN_STATES),
  profile: Schema.optionalKey(ProfileIdSchema),
  host: HostSchema,
  runtime: RuntimeSchema,
  closeOnReport: Schema.Boolean,
  reportGeneration: nonNegativeInteger,
  parentRunId: Schema.optionalKey(boundedString(MAX_PROTOCOL_ID_CHARS, 1)),
  depth: Schema.optionalKey(nonNegativeInteger),
  directChildCount: Schema.optionalKey(nonNegativeInteger),
  descendantCount: Schema.optionalKey(nonNegativeInteger),
  nativeActivity: Schema.optionalKey(
    Schema.Struct({
      active: nonNegativeInteger,
      total: nonNegativeInteger,
      latest: Schema.optionalKey(
        Schema.Struct({
          id: Schema.optionalKey(boundedString(256, 1)),
          kind: boundedString(128, 1),
          state: Schema.Literals([
            "running",
            "activity",
            "completed",
            "failed",
            "stopped",
          ] as const),
          updatedAt: nonNegativeNumber,
        }),
      ),
    }),
  ),
  model: boundedString(MAX_CARD_MODEL_CHARS, 1),
  effort: EffortSchema,
  openaiFastMode: Schema.Boolean,
  context: ContextSchema,
  writeIntent: WriteIntentSchema,
  writeClaims: Schema.optionalKey(
    boundedArray(boundedString(MAX_WRITE_CLAIM_CHARS, 1), MAX_WRITE_CLAIMS).check(
      Schema.isMinLength(1),
    ),
  ),
  writeClaimCount: Schema.optionalKey(nonNegativeInteger),
  writeClaimsOmitted: Schema.optionalKey(Schema.Literal(true)),
  writeAudit: Schema.optionalKey(WriteAuditSchema),
  writeAdmissionPaused: Schema.optionalKey(Schema.Literal(true)),
  writeViolationOffender: Schema.optionalKey(Schema.Literal(true)),
  capabilities: boundedArray(
    Schema.Literals(PI_SUBAGENT_CAPABILITIES),
    PI_SUBAGENT_CAPABILITIES.length,
  ),
  startedAt: nonNegativeNumber,
  lastActivityAt: nonNegativeNumber,
  usage: UsageSchema,
  selection: SelectionSchema,
  currentTool: Schema.optionalKey(boundedString(MAX_CURRENT_TOOL_CHARS, 1)),
  progress: Schema.optionalKey(boundedString(MAX_PROGRESS_CHARS, 1)),
  warning: Schema.optionalKey(boundedString(MAX_WARNING_CHARS, 1)),
  warningSource: Schema.optionalKey(Schema.Literals(["child", "system"])),
  systemWarning: Schema.optionalKey(boundedString(MAX_WARNING_CHARS, 1)),
  endedAt: Schema.optionalKey(nonNegativeNumber),
  finalText: Schema.optionalKey(boundedString(MAX_FINAL_TEXT_CHARS, 1)),
  error: Schema.optionalKey(boundedString(MAX_ERROR_CHARS, 1)),
  finalTextTruncated: Schema.optionalKey(Schema.Literal(true)),
  errorTruncated: Schema.optionalKey(Schema.Literal(true)),
  question: Schema.optionalKey(
    Schema.Struct({ message: boundedString(MAX_CARD_QUESTION_CHARS, 1) }),
  ),
});

const StartEntryIdentityFields = {
  index: nonNegativeInteger,
  name: boundedString(MAX_NAME_CHARS, 1),
  profile: boundedString(MAX_PROFILE_CHARS, 1),
};
const SelectedStartEntryFields = {
  ...WorkspaceCardFields,
  routeStatus: Schema.Literal("selected"),
  host: HostSchema,
  runtime: RuntimeSchema,
  model: boundedString(MAX_CARD_MODEL_CHARS, 1),
  effort: EffortSchema,
  openaiFastMode: Schema.Boolean,
  candidateIndex: Schema.optionalKey(nonNegativeInteger),
  warning: Schema.optionalKey(boundedString(MAX_CARD_PROVENANCE_CHARS, 1)),
};
const PendingStartEntrySchema = Schema.Struct({
  ...StartEntryIdentityFields,
  status: Schema.Literal("pending"),
  routeStatus: Schema.Literal("resolving"),
});
const StartedStartEntrySchema = Schema.Struct({
  ...StartEntryIdentityFields,
  status: Schema.Literal("started"),
  ...SelectedStartEntryFields,
  runId: boundedString(MAX_PROTOCOL_ID_CHARS, 1),
});
const FailedSelectedStartEntrySchema = Schema.Struct({
  ...StartEntryIdentityFields,
  status: Schema.Literal("failed"),
  ...SelectedStartEntryFields,
});
const FailedUnavailableStartEntrySchema = Schema.Struct({
  ...StartEntryIdentityFields,
  status: Schema.Literal("failed"),
  routeStatus: Schema.Literal("unavailable"),
});
export const SubagentStartEntrySchema = Schema.Union([
  PendingStartEntrySchema,
  StartedStartEntrySchema,
  FailedSelectedStartEntrySchema,
  FailedUnavailableStartEntrySchema,
]);

const FailedStartRecoverySchema = Schema.Struct({
  runId: boundedString(MAX_PROTOCOL_ID_CHARS, 1),
  cleanupDisposition: Schema.Literals(FAILED_START_CLEANUP_DISPOSITIONS),
  retryDisposition: Schema.Literals(FAILED_START_RETRY_DISPOSITIONS),
  remainingCandidateCount: nonNegativeInteger,
  hasRemainingCandidate: Schema.Boolean,
});

export const SubagentCardFailureSchema = Schema.Struct({
  index: nonNegativeInteger,
  name: Schema.optionalKey(boundedString(MAX_NAME_CHARS, 1)),
  message: boundedString(MAX_FAILURE_MESSAGE_CHARS, 1),
  code: Schema.optionalKey(boundedString(MAX_FAILURE_CODE_CHARS, 1)),
  admittedRun: Schema.optionalKey(FailedStartRecoverySchema),
});

const hasValidProfileCandidatePolicy = Schema.makeFilter((candidate: ProfileCandidate) =>
  profileCandidateValidationIssues(candidate).length === 0
    ? true
    : "Profile candidate violates cross-field policy.",
);
const ProfileCandidateCardSchema = Schema.Struct({
  host: HostSchema,
  runtime: RuntimeSchema,
  model: boundedString(MAX_PROFILE_MODEL_SELECTOR_CHARS, 1),
  effort: CandidateEffortSchema,
  context: ContextSchema,
  writeIntent: WriteIntentSchema,
  openaiFastMode: Schema.Boolean,
  closeOnReport: Schema.Boolean,
  status: Schema.Literals(["eligible", "skipped"] as const),
  reason: boundedString(MAX_PROFILE_CANDIDATE_REASON_CHARS, 1),
}).check(hasValidProfileCandidatePolicy);
export const SubagentProfileRouteCardSchema = Schema.Struct({
  id: ProfileIdSchema,
  description: boundedString(MAX_PROFILE_DESCRIPTION_CHARS, 1),
  source: ProfileSourceSchema,
  isDefault: Schema.Boolean,
  defaultContext: ContextSchema,
  defaultWriteIntent: WriteIntentSchema,
  defaultEffort: Schema.optionalKey(EffortSchema),
  candidates: boundedArray(ProfileCandidateCardSchema, MAX_PROFILE_CANDIDATES),
});

export const CompactToolActionFailureSchema = Schema.Struct({
  id: boundedString(MAX_ACTION_FAILURE_ID_CHARS, 1),
  code: Schema.optionalKey(boundedString(MAX_ACTION_FAILURE_CODE_CHARS, 1)),
  message: boundedString(MAX_ACTION_FAILURE_MESSAGE_CHARS, 1),
});

export const SubagentStartDetailsSchema = Schema.Struct({
  version: Schema.Literal(SUBAGENT_CARD_DETAILS_VERSION),
  action: Schema.Literal("start"),
  startEntries: boundedArray(SubagentStartEntrySchema, MAX_START_BATCH).check(
    Schema.isMinLength(1),
  ),
  startFailures: Schema.optionalKey(boundedArray(SubagentCardFailureSchema, MAX_START_BATCH)),
});

export const SubagentAwaitDetailsSchema = Schema.Struct({
  version: Schema.Literal(SUBAGENT_CARD_DETAILS_VERSION),
  action: Schema.Literal("await"),
  cards: boundedArray(SubagentRunCardSchema, MAX_TARGET_RUNS),
  awaitedRunIds: Schema.optionalKey(
    boundedArray(boundedString(MAX_PROTOCOL_ID_CHARS, 1), MAX_TARGET_RUNS),
  ),
  awaitUntil: Schema.Literals(["all_finished", "any_finished"] as const),
  timedOut: Schema.optionalKey(Schema.Literal(true)),
  attentionRequired: Schema.optionalKey(Schema.Literal(true)),
  cancelled: Schema.optionalKey(Schema.Literal(true)),
  contextOmitted: Schema.optionalKey(Schema.Literal(true)),
  reportsOnlyOmitted: Schema.optionalKey(Schema.Literal(true)),
  contentOmitted: Schema.optionalKey(Schema.Literal(true)),
});

export const RUN_DETAILS_ACTIONS = [
  "list",
  "status",
  "send",
  "reply",
  "retry",
  "interrupt",
  "resume",
  "stop",
  "rename",
  "claims",
] as const;
export type RunDetailsAction = (typeof RUN_DETAILS_ACTIONS)[number];

const RunActionDetailsSchema = Schema.Struct({
  version: Schema.Literal(SUBAGENT_CARD_DETAILS_VERSION),
  cards: boundedArray(SubagentRunCardSchema, MAX_TARGET_RUNS),
  runCount: nonNegativeInteger,
  actionFailures: Schema.optionalKey(boundedArray(CompactToolActionFailureSchema, MAX_TARGET_RUNS)),
  contentOmitted: Schema.optionalKey(Schema.Literal(true)),
  reportsOnlyOmitted: Schema.optionalKey(Schema.Literal(true)),
  action: Schema.Literals(RUN_DETAILS_ACTIONS),
});

export const SubagentModelsDetailsSchema = Schema.Struct({
  version: Schema.Literal(SUBAGENT_CARD_DETAILS_VERSION),
  action: Schema.Literal("models"),
  profiles: boundedArray(SubagentProfileRouteCardSchema, PROFILE_IDS.length),
  fallbackProfile: ProfileIdSchema,
  contentOmitted: Schema.optionalKey(Schema.Literal(true)),
});

export const CompactSubagentToolDetailsSchema = Schema.Union([
  SubagentModelsDetailsSchema,
  RunActionDetailsSchema,
]);

export const SubagentStartAwaitCardDetailsSchema = Schema.Union([
  SubagentStartDetailsSchema,
  SubagentAwaitDetailsSchema,
]);
export type SubagentRunCard = Schema.Schema.Type<typeof SubagentRunCardSchema>;
export type SubagentStartEntry = Schema.Schema.Type<typeof SubagentStartEntrySchema>;
export type SubagentCardFailure = Schema.Schema.Type<typeof SubagentCardFailureSchema>;
export type SubagentProfileCandidateCard = Schema.Schema.Type<typeof ProfileCandidateCardSchema>;
export type SubagentProfileRouteCard = Schema.Schema.Type<typeof SubagentProfileRouteCardSchema>;
export type CompactToolActionFailure = Schema.Schema.Type<typeof CompactToolActionFailureSchema>;
export type SubagentStartDetails = Schema.Schema.Type<typeof SubagentStartDetailsSchema>;
export type SubagentAwaitDetails = Schema.Schema.Type<typeof SubagentAwaitDetailsSchema>;
export type SubagentStartAwaitCardDetails = Schema.Schema.Type<
  typeof SubagentStartAwaitCardDetailsSchema
>;
export type CompactSubagentToolDetails = Schema.Schema.Type<
  typeof CompactSubagentToolDetailsSchema
>;
export const DETAILS_PARSE_OPTIONS = {
  errors: "first",
  onExcessProperty: "ignore",
  propertyOrder: "none",
  reportInput: false,
} as const;

const START_KEYS = new Set(Object.keys(SubagentStartDetailsSchema.fields));
const AWAIT_KEYS = new Set(Object.keys(SubagentAwaitDetailsSchema.fields));
const MODELS_KEYS = new Set(Object.keys(SubagentModelsDetailsSchema.fields));
const RUN_ACTION_KEYS = new Set(Object.keys(RunActionDetailsSchema.fields));
const KNOWN_ROOT_KEYS = new Set([...START_KEYS, ...AWAIT_KEYS, ...MODELS_KEYS, ...RUN_ACTION_KEYS]);
const RUN_ACTION_SET: ReadonlySet<string> = new Set(RUN_DETAILS_ACTIONS);

const recordOf = <ValueInput>(value: ValueInput): Readonly<JsonObject> | undefined => {
  if (!hasObjectRuntimeType(value) || value === null || Array.isArray(value)) return undefined;
  // SAFETY: This shallow hostile-input view reads only known fields. The selected details schema
  // decodes every field before it enters a persisted details type.
  return value as ValueInput & Readonly<JsonObject>;
};
const hasOwn = (record: Readonly<JsonObject>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);
const readKnown = (record: Readonly<JsonObject>, key: string): JsonValue | undefined => record[key];

const rootKeysAllowed = (record: Readonly<JsonObject>, allowed: ReadonlySet<string>): boolean => {
  for (const key of KNOWN_ROOT_KEYS) if (!allowed.has(key) && hasOwn(record, key)) return false;
  return true;
};

const preflightArray = (
  record: Readonly<JsonObject>,
  key: string,
  maximum: number,
  visit?: (entry: JsonValue) => boolean,
): boolean => {
  if (!hasOwn(record, key)) return true;
  const value = readKnown(record, key);
  if (!Array.isArray(value)) return true;
  const length = value.length;
  if (length > maximum) return false;
  if (!visit) return true;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) continue;
    // SAFETY: The descriptor value is used only for another guarded preflight. Schema performs the
    // authoritative child decode after every known array length has passed its bound.
    const entry = descriptor.value as JsonValue;
    if (!visit(entry)) return false;
  }
  return true;
};

const preflightCard = <ValueInput>(value: ValueInput): boolean => {
  const card = recordOf(value);
  if (!card) return true;
  if (!preflightArray(card, "capabilities", PI_SUBAGENT_CAPABILITIES.length)) return false;
  if (!preflightArray(card, "writeClaims", MAX_WRITE_CLAIMS)) return false;
  if (hasOwn(card, "writeAudit")) {
    const audit = recordOf(readKnown(card, "writeAudit"));
    if (
      audit &&
      (!preflightArray(audit, "observedFileWrites", MAX_OBSERVED_WRITE_PATHS) ||
        !preflightArray(audit, "violations", MAX_WRITE_CLAIM_VIOLATIONS))
    )
      return false;
  }
  if (!hasOwn(card, "selection")) return true;
  const selection = recordOf(readKnown(card, "selection"));
  return !selection || preflightArray(selection, "skippedCandidates", MAX_CARD_SKIPS);
};

const preflightProfile = <ValueInput>(value: ValueInput): boolean => {
  const profile = recordOf(value);
  return !profile || preflightArray(profile, "candidates", MAX_PROFILE_CANDIDATES);
};

/**
 * Checks every bounded known array before Schema traverses it. Each array length is read before
 * any of its elements, and unknown object keys are never read.
 */
const preflight = <ValueInput>(value: ValueInput): boolean => {
  const record = recordOf(value);
  if (!record) return true;
  const action = readKnown(record, "action");
  if (action === "start")
    return (
      rootKeysAllowed(record, START_KEYS) &&
      preflightArray(record, "startEntries", MAX_START_BATCH) &&
      preflightArray(record, "startFailures", MAX_START_BATCH)
    );
  if (action === "await")
    return (
      rootKeysAllowed(record, AWAIT_KEYS) &&
      preflightArray(record, "cards", MAX_TARGET_RUNS, preflightCard) &&
      preflightArray(record, "awaitedRunIds", MAX_TARGET_RUNS)
    );
  if (action === "models")
    return (
      rootKeysAllowed(record, MODELS_KEYS) &&
      preflightArray(record, "profiles", PROFILE_IDS.length, preflightProfile)
    );
  if (Predicate.isString(action) && RUN_ACTION_SET.has(action))
    return (
      rootKeysAllowed(record, RUN_ACTION_KEYS) &&
      preflightArray(record, "cards", MAX_TARGET_RUNS, preflightCard) &&
      preflightArray(record, "actionFailures", MAX_TARGET_RUNS)
    );
  return true;
};

interface StartRelationships {
  readonly failedIndexes: ReadonlySet<number>;
  readonly runIds: Set<string>;
}

const collectStartRelationships = (
  entries: SubagentStartDetails["startEntries"],
): StartRelationships | undefined => {
  const failedIndexes = new Set<number>();
  const runIds = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.index !== index) return undefined;
    if (entry.status === "failed") failedIndexes.add(index);
    if (entry.status !== "started") continue;
    if (runIds.has(entry.runId)) return undefined;
    runIds.add(entry.runId);
  }
  return { failedIndexes, runIds };
};

type FailedStartRecovery = NonNullable<SubagentCardFailure["admittedRun"]>;

const validRetryDisposition = (recovery: FailedStartRecovery): boolean => {
  switch (recovery.retryDisposition) {
    case "eligible":
      return recovery.cleanupDisposition === "confirmed" && recovery.hasRemainingCandidate;
    case "pending":
      return recovery.cleanupDisposition === "pending" && recovery.hasRemainingCandidate;
    case "blocked":
      return recovery.hasRemainingCandidate;
    case "exhausted":
    case "unavailable":
      return !recovery.hasRemainingCandidate;
  }
};

const registerRecovery = (
  entry: SubagentStartDetails["startEntries"][number] | undefined,
  recovery: FailedStartRecovery,
  runIds: Set<string>,
): boolean => {
  if (entry?.routeStatus !== "selected" || runIds.has(recovery.runId)) return false;
  if (recovery.hasRemainingCandidate !== recovery.remainingCandidateCount > 0) return false;
  if (!validRetryDisposition(recovery)) return false;
  runIds.add(recovery.runId);
  return true;
};

const validStartRelationships = (details: SubagentStartDetails): boolean => {
  const relationships = collectStartRelationships(details.startEntries);
  if (!relationships) return false;
  const failures = details.startFailures ?? [];
  if (failures.length !== relationships.failedIndexes.size) return false;
  const seenFailures = new Set<number>();
  let previousFailureIndex = -1;
  for (const failure of failures) {
    if (
      !relationships.failedIndexes.has(failure.index) ||
      seenFailures.has(failure.index) ||
      failure.index <= previousFailureIndex
    )
      return false;
    seenFailures.add(failure.index);
    previousFailureIndex = failure.index;
    if (
      failure.admittedRun &&
      !registerRecovery(
        details.startEntries[failure.index],
        failure.admittedRun,
        relationships.runIds,
      )
    )
      return false;
  }
  return true;
};

const validRunCardRelationships = (card: SubagentRunCard): boolean =>
  card.writeViolationOffender !== true ||
  // Offender identity is authoritative; bounded audit evidence may be absent.
  (card.writeIntent === "writer" && card.writeAdmissionPaused === true);

const validReportOmission = (details: {
  readonly reportsOnlyOmitted?: true;
  readonly contentOmitted?: true;
  readonly cards: ReadonlyArray<SubagentRunCard>;
  readonly actionFailures?: ReadonlyArray<unknown>;
}): boolean =>
  details.reportsOnlyOmitted !== true ||
  (details.contentOmitted === true &&
    !details.actionFailures?.length &&
    details.cards.some((card) => card.finalTextTruncated && card.finalText === undefined) &&
    details.cards.every((card) => card.error === undefined && !card.errorTruncated));

const validAwaitRelationships = (details: SubagentAwaitDetails): boolean => {
  if (!validReportOmission(details) || !details.cards.every(validRunCardRelationships))
    return false;
  const awaitedRunIds = details.awaitedRunIds;
  if (!awaitedRunIds) return true;
  const uniqueTargets = new Set(awaitedRunIds);
  if (uniqueTargets.size !== awaitedRunIds.length) return false;
  if (details.cards.length === 0) return true;
  const cardIds = new Set(details.cards.map((card) => card.id));
  if (!awaitedRunIds.every((id) => cardIds.has(id))) return false;
  return details.cards.every(
    (card) =>
      uniqueTargets.has(card.id) || (card.finalText === undefined && card.error === undefined),
  );
};

const safeDecode = <S extends Schema.ConstraintDecoder<unknown>, ValueInput>(
  schema: S,
  value: ValueInput,
  validate?: (decoded: S["Type"]) => boolean,
): S["Type"] | undefined => {
  try {
    if (!preflight(value)) return undefined;
    const decoded = Schema.decodeUnknownSync(schema, DETAILS_PARSE_OPTIONS)(value);
    if (validate && !validate(decoded)) return undefined;
    const serialized = JSON.stringify(decoded);
    if (serialized.length > MAX_TOOL_OUTPUT_CHARS) return undefined;
    return freezeSnapshot(decoded);
  } catch {
    return undefined;
  }
};

/** Safe current-version decoder for start and await renderer details. */
export const decodeStartAwaitCardDetails = <ValueInput>(
  value: ValueInput,
): SubagentStartAwaitCardDetails | undefined =>
  safeDecode(SubagentStartAwaitCardDetailsSchema, value, (details) =>
    details.action === "start"
      ? validStartRelationships(details)
      : validAwaitRelationships(details),
  );

/** Safe current-version decoder for all non-start tool details. */
export const decodeCompactToolDetails = <ValueInput>(
  value: ValueInput,
): CompactSubagentToolDetails | undefined =>
  safeDecode(
    CompactSubagentToolDetailsSchema,
    value,
    (details) =>
      details.action === "models" ||
      (validReportOmission(details) && details.cards.every(validRunCardRelationships)),
  );
