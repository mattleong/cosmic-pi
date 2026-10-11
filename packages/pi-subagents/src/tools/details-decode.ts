import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "pi-cosmic-core";
import { MAX_PROFILE_CANDIDATES, PROFILE_IDS } from "../profiles/model.ts";
import { MAX_START_BATCH, MAX_TARGET_RUNS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { MAX_WRITE_CLAIMS } from "../domain/write-claims.ts";
import { MAX_OBSERVED_WRITE_PATHS, MAX_WRITE_CLAIM_VIOLATIONS } from "../run/claims-observation.ts";
import { PI_SUBAGENT_CAPABILITIES } from "../run/model.ts";
import {
  CompactSubagentToolDetailsSchema,
  DETAILS_PARSE_OPTIONS,
  MAX_CARD_SKIPS,
  RUN_DETAILS_ACTIONS,
  RunActionDetailsSchema,
  SubagentAwaitDetailsSchema,
  SubagentModelsDetailsSchema,
  SubagentStartAwaitCardDetailsSchema,
  SubagentStartDetailsSchema,
  type CompactSubagentToolDetails,
  type SubagentAwaitDetails,
  type SubagentCardFailure,
  type SubagentRunCard,
  type SubagentStartAwaitCardDetails,
  type SubagentStartDetails,
} from "./details-schema.ts";

const START_KEYS = new Set(Object.keys(SubagentStartDetailsSchema.fields));
const AWAIT_KEYS = new Set(Object.keys(SubagentAwaitDetailsSchema.fields));
const MODELS_KEYS = new Set(Object.keys(SubagentModelsDetailsSchema.fields));
const RUN_ACTION_KEYS = new Set(Object.keys(RunActionDetailsSchema.fields));
const KNOWN_ROOT_KEYS = new Set([...START_KEYS, ...AWAIT_KEYS, ...MODELS_KEYS, ...RUN_ACTION_KEYS]);
const RUN_ACTION_SET: ReadonlySet<string> = new Set(RUN_DETAILS_ACTIONS);

const rootKeysAllowed = <Container>(record: Container, allowed: ReadonlySet<string>): boolean => {
  if (!Predicate.isObject(record)) return true;
  for (const key of KNOWN_ROOT_KEYS)
    if (!allowed.has(key) && Object.hasOwn(record, key)) return false;
  return true;
};

const preflightArray = <Container>(
  record: Container,
  key: string,
  maximum: number,
  visit?: <Entry>(entry: Entry) => boolean,
): boolean => {
  if (!Predicate.isObject(record) || !Object.hasOwn(record, key)) return true;
  const value = record[key];
  if (!Array.isArray(value)) return true;
  const length = value.length;
  if (length > maximum) return false;
  if (!visit) return true;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) continue;
    if (!visit(descriptor.value)) return false;
  }
  return true;
};

const preflightCard = <ValueInput>(card: ValueInput): boolean => {
  if (!Predicate.isObject(card)) return true;
  if (!preflightArray(card, "capabilities", PI_SUBAGENT_CAPABILITIES.length)) return false;
  if (!preflightArray(card, "writeClaims", MAX_WRITE_CLAIMS)) return false;
  if (Object.hasOwn(card, "writeAudit")) {
    const audit = card.writeAudit;
    if (
      Predicate.isObject(audit) &&
      (!preflightArray(audit, "observedFileWrites", MAX_OBSERVED_WRITE_PATHS) ||
        !preflightArray(audit, "violations", MAX_WRITE_CLAIM_VIOLATIONS))
    )
      return false;
  }
  if (!Object.hasOwn(card, "selection")) return true;
  const selection = card.selection;
  return (
    !Predicate.isObject(selection) || preflightArray(selection, "skippedCandidates", MAX_CARD_SKIPS)
  );
};

const preflightProfile = <ValueInput>(profile: ValueInput): boolean =>
  !Predicate.isObject(profile) || preflightArray(profile, "candidates", MAX_PROFILE_CANDIDATES);

const preflight = <ValueInput>(record: ValueInput): boolean => {
  if (!Predicate.isObject(record)) return true;
  const action = record.action;
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
  let previousFailureIndex = -1;
  for (const failure of failures) {
    if (!relationships.failedIndexes.has(failure.index) || failure.index <= previousFailureIndex)
      return false;
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
    if (JSON.stringify(decoded).length > MAX_TOOL_OUTPUT_CHARS) return undefined;
    return freezeSnapshot(decoded);
  } catch {
    return undefined;
  }
};

export const decodeStartAwaitCardDetails = <ValueInput>(
  value: ValueInput,
): SubagentStartAwaitCardDetails | undefined =>
  safeDecode(SubagentStartAwaitCardDetailsSchema, value, (details) =>
    details.action === "start"
      ? validStartRelationships(details)
      : validAwaitRelationships(details),
  );

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
