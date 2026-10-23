import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import { MAX_RESOLVED_CUSTOM_AGENTS } from "../profiles/agents.ts";
import { MAX_PROFILE_CANDIDATES, PROFILE_IDS } from "../profiles/model.ts";
import { MAX_START_BATCH, MAX_TARGET_RUNS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import {
  CompactSubagentToolDetailsSchema,
  DETAILS_PARSE_OPTIONS,
  MAX_CARD_CAPABILITIES,
  MAX_CARD_SKIPS,
  MAX_INVALID_AGENT_ENTRIES,
  RUN_DETAILS_ACTIONS,
  RunActionDetailsSchema,
  SubagentAwaitDetailsSchema,
  SubagentModelsDetailsSchema,
  SubagentStartAwaitCardDetailsSchema,
  SubagentStartDetailsSchema,
  type SubagentAwaitDetails,
  type SubagentCardFailure,
  type SubagentRunCard,
  type SubagentStartDetails,
} from "./details-schema.ts";

const START_KEYS = new Set(Rec.keys(SubagentStartDetailsSchema.fields));
const AWAIT_KEYS = new Set(Rec.keys(SubagentAwaitDetailsSchema.fields));
const MODELS_KEYS = new Set(Rec.keys(SubagentModelsDetailsSchema.fields));
const RUN_ACTION_KEYS = new Set(Rec.keys(RunActionDetailsSchema.fields));
const KNOWN_ROOT_KEYS = new Set([...START_KEYS, ...AWAIT_KEYS, ...MODELS_KEYS, ...RUN_ACTION_KEYS]);
const RUN_ACTION_SET: ReadonlySet<string> = new Set(RUN_DETAILS_ACTIONS);

const DetailsFieldsSchema = Schema.Record(Schema.String, Schema.Unknown);
type DetailsFields = typeof DetailsFieldsSchema.Type;
type FieldsVisitor = (entry: DetailsFields | undefined) => boolean;

const rootKeysAllowed = (record: DetailsFields, allowed: ReadonlySet<string>): boolean => {
  for (const key of KNOWN_ROOT_KEYS) if (!allowed.has(key) && Rec.has(record, key)) return false;
  return true;
};

const preflightArray = (
  record: DetailsFields,
  key: string,
  maximum: number,
  visit?: FieldsVisitor,
): boolean => {
  if (!Rec.has(record, key)) return true;
  const value = record[key];
  if (!Arr.isArray(value)) return true;
  const length = value.length;
  if (length > maximum) return false;
  if (!visit) return true;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) continue;
    if (!visit(Predicate.isObject(descriptor.value) ? descriptor.value : undefined)) return false;
  }
  return true;
};

const preflightCard: FieldsVisitor = (card) => {
  if (!card) return true;
  if (!preflightArray(card, "capabilities", MAX_CARD_CAPABILITIES)) return false;
  if (!Rec.has(card, "selection")) return true;
  const selection = card.selection;
  return (
    !Predicate.isObject(selection) || preflightArray(selection, "skippedCandidates", MAX_CARD_SKIPS)
  );
};

const preflightProfile: FieldsVisitor = (profile) =>
  !profile || preflightArray(profile, "candidates", MAX_PROFILE_CANDIDATES);

const preflightRecord = (record: DetailsFields): boolean => {
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
      preflightArray(record, "profiles", PROFILE_IDS.length, preflightProfile) &&
      preflightArray(record, "agents", MAX_RESOLVED_CUSTOM_AGENTS, preflightProfile) &&
      preflightArray(record, "invalidAgents", MAX_INVALID_AGENT_ENTRIES)
    );
  if (Predicate.isString(action) && RUN_ACTION_SET.has(action))
    return (
      rootKeysAllowed(record, RUN_ACTION_KEYS) &&
      preflightArray(record, "cards", MAX_TARGET_RUNS, preflightCard) &&
      preflightArray(record, "actionFailures", MAX_TARGET_RUNS)
    );
  return true;
};

const PreflightedDetails = Schema.Unknown.check(
  Schema.makeFilter((input) => !Predicate.isObject(input) || preflightRecord(input)),
);
const decodePreflighted = Schema.decodeUnknownOption(PreflightedDetails);

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

const registerRecovery = (
  entry: SubagentStartDetails["startEntries"][number] | undefined,
  recovery: FailedStartRecovery,
  runIds: Set<string>,
): boolean => {
  if (entry?.routeStatus !== "selected" || runIds.has(recovery.runId)) return false;
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

const validReportOmission = (details: {
  readonly reportsOnlyOmitted?: true;
  readonly contentOmitted?: true;
  readonly cards: ReadonlyArray<SubagentRunCard>;
  readonly actionFailures?: ReadonlyArray<unknown>;
}): boolean =>
  details.reportsOnlyOmitted !== true ||
  (details.contentOmitted === true &&
    !details.actionFailures?.length &&
    Arr.some(
      details.cards,
      (card) => card.finalTextTruncated === true && card.finalText === undefined,
    ) &&
    Arr.every(details.cards, (card) => card.error === undefined && !card.errorTruncated));

const validAwaitRelationships = (details: SubagentAwaitDetails): boolean => {
  if (!validReportOmission(details)) return false;
  const awaitedRunIds = details.awaitedRunIds;
  if (!awaitedRunIds) return true;
  const uniqueTargets = new Set(awaitedRunIds);
  if (uniqueTargets.size !== awaitedRunIds.length) return false;
  if (details.cards.length === 0) return true;
  const cardIds = new Set(Arr.map(details.cards, (card) => card.id));
  if (!Arr.every(awaitedRunIds, (id) => cardIds.has(id))) return false;
  return Arr.every(
    details.cards,
    (card) =>
      uniqueTargets.has(card.id) || (card.finalText === undefined && card.error === undefined),
  );
};

const isObjectValue = Schema.is(Schema.ObjectKeyword);
// A hostile proxy can throw even here; such input is decoded, and rejected, without the cache.
const isFrozenObject = Option.liftThrowable(Object.isFrozen);

const safeDecoder = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  validate: (decoded: S["Type"]) => boolean,
) => {
  const decodeTarget = Schema.decodeUnknownOption(schema, DETAILS_PARSE_OPTIONS);
  const decode = Fn.flow(
    Option.liftThrowable(
      Fn.flow(
        decodePreflighted,
        Option.flatMap(decodeTarget),
        Option.filter(validate),
        Option.filter((decoded) => JSON.stringify(decoded).length <= MAX_TOOL_OUTPUT_CHARS),
        Option.map(freezeSnapshot),
      ),
    ),
    Option.flatten,
    Option.getOrUndefined,
  );
  // Published details are deep-frozen and never change, so each decodes once however often it renders.
  const decodedFrozen = new WeakMap<object, S["Type"] | undefined>();
  return (input: unknown): S["Type"] | undefined => {
    if (!isObjectValue(input) || !Option.getOrElse(isFrozenObject(input), () => false))
      return decode(input);
    if (decodedFrozen.has(input)) return decodedFrozen.get(input);
    const decoded = decode(input);
    decodedFrozen.set(input, decoded);
    return decoded;
  };
};

const validStartAwaitDetails = (details: typeof SubagentStartAwaitCardDetailsSchema.Type) =>
  details.action === "start" ? validStartRelationships(details) : validAwaitRelationships(details);

const validCompactDetails = (details: typeof CompactSubagentToolDetailsSchema.Type) =>
  details.action === "models" || validReportOmission(details);

export const decodeStartAwaitCardDetails = safeDecoder(
  SubagentStartAwaitCardDetailsSchema,
  validStartAwaitDetails,
);

export const decodeCompactToolDetails = safeDecoder(
  CompactSubagentToolDetailsSchema,
  validCompactDetails,
);

export const decodeOutcomeDetails = safeDecoder(
  Schema.Union([SubagentStartAwaitCardDetailsSchema, CompactSubagentToolDetailsSchema]),
  (details) =>
    details.action === "start" || details.action === "await"
      ? validStartAwaitDetails(details)
      : validCompactDetails(details),
);
