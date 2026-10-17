import * as Schema from "effect/Schema";
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
  PROFILE_ROUTE_SOURCES,
  profileCandidateValidationIssues,
  type ProfileCandidate,
} from "../profiles/model.ts";
import { MAX_PROTOCOL_ID_CHARS, MAX_START_BATCH, MAX_TARGET_RUNS } from "../run/limits.ts";
import { MAX_WRITE_CLAIMS, MAX_WRITE_CLAIM_CHARS } from "../domain/write-claims.ts";
import { MAX_OBSERVED_WRITE_PATHS, MAX_WRITE_CLAIM_VIOLATIONS } from "../run/claims-observation.ts";
import {
  FAILED_START_CLEANUP_DISPOSITIONS,
  FAILED_START_RETRY_DISPOSITIONS,
  PI_SUBAGENT_CAPABILITIES,
  SUBAGENT_RUN_STATES,
  STEERING_DELIVERY_STATES,
} from "../run/model.ts";
import { MAX_ERROR_CHARS, MAX_FINAL_TEXT_CHARS, MAX_NAME_CHARS } from "../run/state.ts";
import { WriterWorkspaceModeSchema } from "../config/schema.ts";
import { AWAIT_UNTIL } from "./schema.ts";

export const SUBAGENT_CARD_DETAILS_VERSION = 2;
export const MAX_CARD_MODEL_CHARS = 512;
export const MAX_CARD_PROVENANCE_CHARS = 1_024;
export const MAX_CARD_QUESTION_CHARS = 2_048;
export const MAX_CARD_SKIPS = 8;

export const MAX_PROFILE_DESCRIPTION_CHARS = 512;
export const MAX_PROFILE_CANDIDATE_REASON_CHARS = 1_024;
export const MAX_PROFILE_CHARS = 64;
export const MAX_ACTION_FAILURE_ID_CHARS = 128;
export const MAX_ACTION_FAILURE_CODE_CHARS = 64;
export const MAX_ACTION_FAILURE_MESSAGE_CHARS = 256;
export const MAX_FAILURE_CODE_CHARS = 128;
export const MAX_FAILURE_MESSAGE_CHARS = 512;
export const MAX_CURRENT_TOOL_CHARS = 256;
export const MAX_PROGRESS_CHARS = 512;
export const MAX_WARNING_CHARS = 512;

export const NonEmptyText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const nonNegativeNumber = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const nonNegativeInteger = nonNegativeNumber.check(Schema.isInt());
const boundedArray = <S extends Schema.Constraint>(schema: S, maximum: number) =>
  Schema.Array(schema).check(Schema.isMaxLength(maximum));

const MAX_WORKSPACE_WARNINGS = 6;
const MAX_WORKSPACE_WARNING_DETAIL_CHARS = 4_096;
const WorkspaceWarningSchema = Schema.Struct({
  code: NonEmptyText(MAX_FAILURE_CODE_CHARS),
  message: NonEmptyText(MAX_WARNING_CHARS),
  detail: NonEmptyText(MAX_WORKSPACE_WARNING_DETAIL_CHARS),
});
export type WorkspaceWarning = typeof WorkspaceWarningSchema.Type;

export const WORKSPACE_VERIFICATION_STATUSES = ["passed", "not-configured", "failed"] as const;
export const MAX_WORKSPACE_VERIFICATION_TEXT_CHARS = 512;

export const WorkspaceToolDetailsSchema = Schema.Struct({
  version: Schema.Literal(1),
  action: Schema.Literal("workspace"),
  operation: Schema.Literals([
    "list",
    "review",
    "prepare",
    "integrate",
    "apply",
    "discard",
    "revise",
  ]),
  workspaceId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
  revisionId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
  preparationId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
  offset: Schema.optionalKey(nonNegativeInteger),
  totalChars: Schema.optionalKey(nonNegativeInteger),
  nextOffset: Schema.optionalKey(nonNegativeInteger),
  workspaceCount: Schema.optionalKey(nonNegativeInteger),
  unavailableCount: Schema.optionalKey(nonNegativeInteger),
  listedCount: Schema.optionalKey(nonNegativeInteger),
  /** Listed entries whose nested source workspace chain can't be resolved; within `unavailableCount`. */
  sourceUnavailableCount: Schema.optionalKey(nonNegativeInteger),
  changedPathCount: Schema.optionalKey(nonNegativeInteger),
  /** Whether the parent had read every diff page of the applied revision. */
  reviewed: Schema.optionalKey(Schema.Boolean),
  verification: Schema.optionalKey(Schema.Literals(WORKSPACE_VERIFICATION_STATUSES)),
  verificationCommand: Schema.optionalKey(NonEmptyText(MAX_WORKSPACE_VERIFICATION_TEXT_CHARS)),
  verificationMessage: Schema.optionalKey(NonEmptyText(MAX_WORKSPACE_VERIFICATION_TEXT_CHARS)),
  preparedCwd: Schema.optionalKey(NonEmptyText(1_024)),
  successorRunId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
  warnings: Schema.optionalKey(boundedArray(WorkspaceWarningSchema, MAX_WORKSPACE_WARNINGS)),
  displayContent: Schema.optionalKey(
    Schema.Struct({
      offset: nonNegativeInteger,
      length: nonNegativeInteger,
    }),
  ),
});
export type WorkspaceToolDetails = typeof WorkspaceToolDetailsSchema.Type;

const HostSchema = Schema.Literals(PROFILE_CANDIDATE_HOSTS);
const RuntimeSchema = Schema.Literals(PROFILE_CANDIDATE_RUNTIMES);
const EffortSchema = Schema.Literals(SUBAGENT_EFFORTS);
const CandidateEffortSchema = Schema.Literals(PROFILE_CANDIDATE_EFFORTS);
const ContextSchema = Schema.Literals(PROFILE_CANDIDATE_CONTEXTS);
const WriteIntentSchema = Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS);
const ProfileIdSchema = Schema.Literals(PROFILE_IDS);
const ProfileSourceSchema = Schema.Literals(PROFILE_ROUTE_SOURCES);

const UsageSchema = Schema.Struct({
  input: nonNegativeNumber,
  output: nonNegativeNumber,
  cacheRead: nonNegativeNumber,
  cacheWrite: nonNegativeNumber,
  totalTokens: nonNegativeNumber,
  cost: Schema.optionalKey(nonNegativeNumber),
});

const SkippedCandidateSchema = Schema.Struct({
  candidate: NonEmptyText(MAX_CARD_PROVENANCE_CHARS),
  code: NonEmptyText(MAX_FAILURE_CODE_CHARS),
  reason: NonEmptyText(MAX_CARD_PROVENANCE_CHARS),
});

const SelectionSchema = Schema.Struct({
  source: Schema.Literals(["profile-candidate", "profile-parent-candidate"] as const),
  candidateIndex: Schema.optionalKey(nonNegativeInteger),
  reason: NonEmptyText(MAX_CARD_PROVENANCE_CHARS),
  skippedCandidates: boundedArray(SkippedCandidateSchema, MAX_CARD_SKIPS),
  warning: Schema.optionalKey(NonEmptyText(MAX_CARD_PROVENANCE_CHARS)),
});

const WriteClaimViolationSchema = Schema.Struct({
  path: NonEmptyText(MAX_WRITE_CLAIM_CHARS),
  toolName: NonEmptyText(200),
  observedAt: nonNegativeNumber,
});

const WriteAuditSchema = Schema.Struct({
  observedFileWrites: boundedArray(NonEmptyText(MAX_WRITE_CLAIM_CHARS), MAX_OBSERVED_WRITE_PATHS),
  violations: boundedArray(WriteClaimViolationSchema, MAX_WRITE_CLAIM_VIOLATIONS),
  bashWriteHints: nonNegativeInteger,
});

export const MAX_CLEANUP_DIAGNOSTIC_MESSAGE_CHARS = 1_024;
export const MAX_CLEANUP_DIAGNOSTIC_CODE_CHARS = 80;
export const RunCleanupSchema = Schema.Struct({
  disposition: Schema.Literals(["pending", "confirmed", "quarantined"]),
  recovery: Schema.optionalKey(Schema.Literals(["stop", "manual"])),
  diagnostic: Schema.optionalKey(
    Schema.Struct({
      phase: Schema.Literals([
        "backend-scope",
        "process-exit",
        "process-group",
        "descendant-snapshot",
        "descendant-groups",
        "writer-lease",
      ]),
      code: Schema.optionalKey(NonEmptyText(MAX_CLEANUP_DIAGNOSTIC_CODE_CHARS)),
      message: NonEmptyText(MAX_CLEANUP_DIAGNOSTIC_MESSAGE_CHARS),
    }),
  ),
});

const WorkspaceCardFields = {
  writerWorkspaceMode: Schema.optionalKey(WriterWorkspaceModeSchema),
  workspaceId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
  cwd: Schema.optionalKey(NonEmptyText(1_024)),
  sourceCwd: Schema.optionalKey(NonEmptyText(1_024)),
};

const WorkspaceOutcomeCardSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("auto-discarded") }),
  Schema.Struct({
    status: Schema.Literal("proposal"),
    changedFileCount: nonNegativeInteger,
    uncapturedFileCount: Schema.optionalKey(nonNegativeInteger),
  }),
]);

export const SubagentRunCardSchema = Schema.Struct({
  ...WorkspaceCardFields,
  workspaceOutcome: Schema.optionalKey(WorkspaceOutcomeCardSchema),
  id: NonEmptyText(MAX_PROTOCOL_ID_CHARS),
  name: NonEmptyText(MAX_NAME_CHARS),
  state: Schema.Literals(SUBAGENT_RUN_STATES),
  steeringDelivery: Schema.optionalKey(Schema.Literals(STEERING_DELIVERY_STATES)),
  profile: Schema.optionalKey(ProfileIdSchema),
  host: HostSchema,
  runtime: RuntimeSchema,
  closeOnReport: Schema.Boolean,
  reportGeneration: nonNegativeInteger,
  reportStatus: Schema.optionalKey(
    Schema.Literals(["available", "claimed", "delivered", "missing"]),
  ),
  parentRunId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
  depth: Schema.optionalKey(nonNegativeInteger),
  directChildCount: Schema.optionalKey(nonNegativeInteger),
  descendantCount: Schema.optionalKey(nonNegativeInteger),
  nativeActivity: Schema.optionalKey(
    Schema.Struct({
      active: nonNegativeInteger,
      total: nonNegativeInteger,
      latest: Schema.optionalKey(
        Schema.Struct({
          id: Schema.optionalKey(NonEmptyText(256)),
          kind: NonEmptyText(128),
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
  model: NonEmptyText(MAX_CARD_MODEL_CHARS),
  effort: EffortSchema,
  openaiFastMode: Schema.Boolean,
  context: ContextSchema,
  writeIntent: WriteIntentSchema,
  writeClaims: Schema.optionalKey(
    boundedArray(NonEmptyText(MAX_WRITE_CLAIM_CHARS), MAX_WRITE_CLAIMS).check(
      Schema.isMinLength(1),
    ),
  ),
  writeClaimCount: Schema.optionalKey(nonNegativeInteger),
  writeClaimsOmitted: Schema.optionalKey(Schema.Literal(true)),
  writeAudit: Schema.optionalKey(WriteAuditSchema),
  writeAdmissionPaused: Schema.optionalKey(Schema.Literal(true)),
  writeViolationOffender: Schema.optionalKey(Schema.Literal(true)),
  cleanup: Schema.optionalKey(RunCleanupSchema),
  writerCleanupQuarantined: Schema.optionalKey(Schema.Boolean),
  capabilities: boundedArray(
    Schema.Literals(PI_SUBAGENT_CAPABILITIES),
    PI_SUBAGENT_CAPABILITIES.length,
  ),
  startedAt: nonNegativeNumber,
  lastActivityAt: nonNegativeNumber,
  usage: UsageSchema,
  selection: SelectionSchema,
  currentTool: Schema.optionalKey(NonEmptyText(MAX_CURRENT_TOOL_CHARS)),
  progress: Schema.optionalKey(NonEmptyText(MAX_PROGRESS_CHARS)),
  warning: Schema.optionalKey(NonEmptyText(MAX_WARNING_CHARS)),
  warningSource: Schema.optionalKey(Schema.Literals(["child", "system"])),
  systemWarning: Schema.optionalKey(NonEmptyText(MAX_WARNING_CHARS)),
  endedAt: Schema.optionalKey(nonNegativeNumber),
  finalText: Schema.optionalKey(NonEmptyText(MAX_FINAL_TEXT_CHARS)),
  error: Schema.optionalKey(NonEmptyText(MAX_ERROR_CHARS)),
  finalTextTruncated: Schema.optionalKey(Schema.Literal(true)),
  errorTruncated: Schema.optionalKey(Schema.Literal(true)),
  question: Schema.optionalKey(Schema.Struct({ message: NonEmptyText(MAX_CARD_QUESTION_CHARS) })),
});

const StartEntryIdentityFields = {
  index: nonNegativeInteger,
  name: NonEmptyText(MAX_NAME_CHARS),
  profile: NonEmptyText(MAX_PROFILE_CHARS),
};
const SelectedStartEntryFields = {
  ...WorkspaceCardFields,
  routeStatus: Schema.Literal("selected"),
  host: HostSchema,
  runtime: RuntimeSchema,
  model: NonEmptyText(MAX_CARD_MODEL_CHARS),
  effort: EffortSchema,
  openaiFastMode: Schema.Boolean,
  candidateIndex: Schema.optionalKey(nonNegativeInteger),
  warning: Schema.optionalKey(NonEmptyText(MAX_CARD_PROVENANCE_CHARS)),
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
  runId: NonEmptyText(MAX_PROTOCOL_ID_CHARS),
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
  runId: NonEmptyText(MAX_PROTOCOL_ID_CHARS),
  cleanupDisposition: Schema.Literals(FAILED_START_CLEANUP_DISPOSITIONS),
  retryDisposition: Schema.Literals(FAILED_START_RETRY_DISPOSITIONS),
  remainingCandidateCount: nonNegativeInteger,
  hasRemainingCandidate: Schema.Boolean,
});

export const SubagentCardFailureSchema = Schema.Struct({
  index: nonNegativeInteger,
  name: Schema.optionalKey(NonEmptyText(MAX_NAME_CHARS)),
  message: NonEmptyText(MAX_FAILURE_MESSAGE_CHARS),
  code: Schema.optionalKey(NonEmptyText(MAX_FAILURE_CODE_CHARS)),
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
  model: NonEmptyText(MAX_PROFILE_MODEL_SELECTOR_CHARS),
  effort: CandidateEffortSchema,
  context: ContextSchema,
  writeIntent: WriteIntentSchema,
  openaiFastMode: Schema.Boolean,
  closeOnReport: Schema.Boolean,
  status: Schema.Literals(["eligible", "skipped"] as const),
  reason: NonEmptyText(MAX_PROFILE_CANDIDATE_REASON_CHARS),
}).check(hasValidProfileCandidatePolicy);
export const SubagentProfileRouteCardSchema = Schema.Struct({
  id: ProfileIdSchema,
  description: NonEmptyText(MAX_PROFILE_DESCRIPTION_CHARS),
  source: ProfileSourceSchema,
  isDefault: Schema.Boolean,
  defaultContext: ContextSchema,
  defaultWriteIntent: WriteIntentSchema,
  defaultEffort: Schema.optionalKey(EffortSchema),
  candidates: boundedArray(ProfileCandidateCardSchema, MAX_PROFILE_CANDIDATES),
});

export const PENDING_DELIVERY_FAILURE_CODE = "steer_outcome_uncertain";

export const CompactToolActionFailureSchema = Schema.Struct({
  id: NonEmptyText(MAX_ACTION_FAILURE_ID_CHARS),
  code: Schema.optionalKey(NonEmptyText(MAX_ACTION_FAILURE_CODE_CHARS)),
  message: NonEmptyText(MAX_ACTION_FAILURE_MESSAGE_CHARS),
  pendingDelivery: Schema.optionalKey(Schema.Literal(true)),
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
    boundedArray(NonEmptyText(MAX_PROTOCOL_ID_CHARS), MAX_TARGET_RUNS),
  ),
  awaitUntil: Schema.Literals(AWAIT_UNTIL),
  attentionRequired: Schema.optionalKey(Schema.Literal(true)),
  cancelled: Schema.optionalKey(Schema.Literal(true)),
  cancellationCleanup: Schema.optionalKey(Schema.Literal("unconfirmed")),
  timedOutSeconds: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))),
  endedByUserInput: Schema.optionalKey(Schema.Literal(true)),
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

export const RunActionDetailsSchema = Schema.Struct({
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
export type SubagentRunCard = typeof SubagentRunCardSchema.Type;
export type SubagentStartEntry = typeof SubagentStartEntrySchema.Type;
export type SubagentCardFailure = typeof SubagentCardFailureSchema.Type;
export type SubagentProfileCandidateCard = typeof ProfileCandidateCardSchema.Type;
export type SubagentProfileRouteCard = typeof SubagentProfileRouteCardSchema.Type;
export type CompactToolActionFailure = typeof CompactToolActionFailureSchema.Type;
export type SubagentStartDetails = typeof SubagentStartDetailsSchema.Type;
export type SubagentAwaitDetails = typeof SubagentAwaitDetailsSchema.Type;
export type SubagentStartAwaitCardDetails = typeof SubagentStartAwaitCardDetailsSchema.Type;
export type CompactSubagentToolDetails = typeof CompactSubagentToolDetailsSchema.Type;
export const DETAILS_PARSE_OPTIONS = {
  errors: "first",
  onExcessProperty: "ignore",
  propertyOrder: "none",
  reportInput: false,
} as const;
