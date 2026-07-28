import { freezeSnapshot, stripTerminalControls } from "pi-cosmic-core";
import type {
  PendingParentQuestion,
  SubagentEffort,
  SubagentRunState,
  SubagentRunView,
} from "../run/model.ts";
import { MAX_PROTOCOL_ID_CHARS, MAX_TARGET_RUNS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import {
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  MAX_NAME_CHARS,
  safeTextPrefix,
  sanitizeName,
  sanitizeOutputText,
} from "../run/state.ts";
import {
  isProfileId,
  type SkippedProfileCandidate,
  type SubagentSelectionProvenance,
  type SubagentSelectionSource,
} from "../profiles/model.ts";

export const SUBAGENT_CARD_DETAILS_VERSION = 1;
const CARD_STRING_BUDGET = 36_000;
const MAX_CARD_MODEL_CHARS = 512;
const MAX_CARD_PROVENANCE_CHARS = 1_024;
const MAX_CARD_QUESTION_CHARS = 2_048;
const MAX_CARD_SKIPS = 8;

export interface SubagentRunCard {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunState;
  readonly profile?: SubagentRunView["profile"] | undefined;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly selection: SubagentSelectionProvenance;
  readonly currentTool?: string | undefined;
  readonly endedAt?: number | undefined;
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly question?: Pick<PendingParentQuestion, "message"> | undefined;
}

export interface SubagentCardFailure {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
}

export interface SubagentStartAwaitCardDetails {
  readonly version: typeof SUBAGENT_CARD_DETAILS_VERSION;
  readonly action: "start" | "await";
  readonly cards: ReadonlyArray<SubagentRunCard>;
  readonly startFailures?: ReadonlyArray<SubagentCardFailure> | undefined;
  readonly awaitUntil?: "all_finished" | "any_finished" | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
}

export interface CompactToolActionFailure {
  readonly id: string;
  readonly code?: string | undefined;
  readonly message: string;
}

export interface CompactSubagentToolDetails {
  readonly version: typeof SUBAGENT_CARD_DETAILS_VERSION;
  readonly action: string;
  readonly runIds?: ReadonlyArray<string> | undefined;
  readonly runCount?: number | undefined;
  readonly modelSelectors?:
    | ReadonlyArray<{
        readonly backend: "pi" | "claude-cli";
        readonly id: string;
      }>
    | undefined;
  readonly modelCount?: number | undefined;
  readonly profileIds?: ReadonlyArray<string> | undefined;
  readonly defaultProfile?: string | undefined;
  readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
}

export interface CompactToolDetailsInput {
  readonly action: string;
  readonly runs?: ReadonlyArray<Pick<SubagentRunView, "id">> | undefined;
  readonly models?:
    | ReadonlyArray<{
        readonly backend: "pi" | "claude-cli";
        readonly id: string;
      }>
    | undefined;
  readonly profileIds?: ReadonlyArray<string> | undefined;
  readonly defaultProfile?: string | undefined;
  readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
}

export interface StartAwaitDetailsInput {
  readonly action: "start" | "await";
  readonly runs: ReadonlyArray<SubagentRunCard>;
  readonly startFailures?: ReadonlyArray<SubagentCardFailure> | undefined;
  readonly awaitUntil?: "all_finished" | "any_finished" | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
}

const clean = (value: string, maximum: number): string =>
  safeTextPrefix(stripTerminalControls(value).replaceAll("\u0000", ""), maximum);

const boundedSelection = (
  selection: SubagentSelectionProvenance,
  take: (value: string, maximum: number) => string,
): SubagentSelectionProvenance => ({
  source: selection.source,
  ...(selection.candidateIndex === undefined ? {} : { candidateIndex: selection.candidateIndex }),
  reason: take(selection.reason, MAX_CARD_PROVENANCE_CHARS),
  skippedCandidates: selection.skippedCandidates.slice(0, MAX_CARD_SKIPS).map((candidate) => ({
    ...(candidate.candidateIndex === undefined ? {} : { candidateIndex: candidate.candidateIndex }),
    candidate: take(candidate.candidate, MAX_CARD_PROVENANCE_CHARS),
    code: take(candidate.code, 128),
    reason: take(candidate.reason, MAX_CARD_PROVENANCE_CHARS),
  })),
  ...(selection.warning ? { warning: take(selection.warning, MAX_CARD_PROVENANCE_CHARS) } : {}),
});

const projectCard = (run: SubagentRunCard, budget: number): SubagentRunCard => {
  let remaining = Math.max(0, budget);
  const take = (value: string, maximum: number): string => {
    const allowed = Math.max(0, Math.min(maximum, remaining));
    const clipped = clean(value, allowed);
    remaining = Math.max(0, remaining - clipped.length);
    return clipped;
  };
  const id = take(run.id, MAX_PROTOCOL_ID_CHARS);
  const name = take(run.name, MAX_NAME_CHARS);
  const model = take(run.model, MAX_CARD_MODEL_CHARS);
  const currentTool = run.currentTool ? take(run.currentTool, 256) : undefined;
  const question = run.question
    ? { message: take(run.question.message, MAX_CARD_QUESTION_CHARS) }
    : undefined;
  const selection = boundedSelection(run.selection, take);
  const finalText = run.finalText
    ? take(sanitizeOutputText(run.finalText, MAX_FINAL_TEXT_CHARS), MAX_FINAL_TEXT_CHARS)
    : undefined;
  const error = run.error
    ? take(sanitizeOutputText(run.error, MAX_ERROR_CHARS), MAX_ERROR_CHARS)
    : undefined;
  return {
    id,
    name,
    state: run.state,
    ...(run.profile ? { profile: run.profile } : {}),
    model,
    effort: run.effort,
    selection,
    ...(currentTool ? { currentTool } : {}),
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(finalText ? { finalText } : {}),
    ...(error ? { error } : {}),
    ...(question?.message ? { question } : {}),
  };
};

const projectFailures = (
  failures: ReadonlyArray<SubagentCardFailure> | undefined,
): ReadonlyArray<SubagentCardFailure> | undefined => {
  if (!failures || failures.length === 0) return undefined;
  return failures.slice(0, MAX_TARGET_RUNS).map((failure) => ({
    index: Number.isSafeInteger(failure.index) && failure.index >= 0 ? failure.index : 0,
    ...(failure.name ? { name: sanitizeName(failure.name) } : {}),
    message: clean(failure.message, 512),
    ...(failure.code ? { code: clean(failure.code, 128) } : {}),
  }));
};

const serializedLength = (value: unknown): number => JSON.stringify(value).length;

const compactCardFallback = (card: SubagentRunCard): SubagentRunCard => ({
  id: clean(card.id, 128),
  name: clean(card.name, 96),
  state: card.state,
  ...(card.profile ? { profile: card.profile } : {}),
  model: clean(card.model, 96),
  effort: card.effort,
  selection: {
    source: card.selection.source,
    ...(card.selection.candidateIndex === undefined
      ? {}
      : { candidateIndex: card.selection.candidateIndex }),
    reason: clean(card.selection.reason, 96),
    skippedCandidates: [],
  },
  ...(card.endedAt === undefined ? {} : { endedAt: card.endedAt }),
  ...(card.question?.message ? { question: { message: clean(card.question.message, 160) } } : {}),
});

const compactFailureFallback = (failure: SubagentCardFailure): SubagentCardFailure => ({
  index: failure.index,
  ...(failure.name ? { name: clean(failure.name, 64) } : {}),
  message: clean(failure.message, 96),
  ...(failure.code ? { code: clean(failure.code, 48) } : {}),
});

/** Versioned, deeply frozen, aggregate-bounded persistence projection for start/await cards. */
export function makeStartAwaitCardDetails(
  input: StartAwaitDetailsInput,
): SubagentStartAwaitCardDetails {
  const failures = projectFailures(input.startFailures);
  const failureBudget =
    failures?.reduce(
      (total, failure) =>
        total + failure.message.length + (failure.name?.length ?? 0) + (failure.code?.length ?? 0),
      0,
    ) ?? 0;
  const cards = input.runs.slice(0, MAX_TARGET_RUNS);
  const perCardBudget = Math.max(
    512,
    Math.floor(Math.max(0, CARD_STRING_BUDGET - failureBudget) / Math.max(1, cards.length)),
  );
  const details: SubagentStartAwaitCardDetails = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: input.action,
    cards: cards.map((run) => projectCard(run, perCardBudget)),
    ...(failures ? { startFailures: failures } : {}),
    ...(input.awaitUntil ? { awaitUntil: input.awaitUntil } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.attentionRequired ? { attentionRequired: true } : {}),
    ...(input.cancelled ? { cancelled: true } : {}),
  };
  // Raw string length is not a serialized bound: backslashes, controls, and lone surrogates can
  // expand several-fold under JSON.stringify. Recheck every fallback stage against the persisted
  // representation and finally drop optional card content rather than return an oversized value.
  const withoutReports: SubagentStartAwaitCardDetails = {
    ...details,
    cards: details.cards.map(({ finalText: _finalText, error: _error, ...card }) => card),
  };
  const compact: SubagentStartAwaitCardDetails = {
    ...withoutReports,
    cards: withoutReports.cards.map(compactCardFallback),
    ...(withoutReports.startFailures
      ? { startFailures: withoutReports.startFailures.map(compactFailureFallback) }
      : {}),
  };
  const minimal: SubagentStartAwaitCardDetails = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: input.action,
    cards: [],
    ...(input.awaitUntil ? { awaitUntil: input.awaitUntil } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.attentionRequired ? { attentionRequired: true } : {}),
    ...(input.cancelled ? { cancelled: true } : {}),
  };
  const bounded = [details, withoutReports, compact, minimal].find(
    (candidate) => serializedLength(candidate) <= MAX_TOOL_OUTPUT_CHARS,
  );
  return freezeSnapshot(bounded ?? minimal);
}

/** Compact, versioned persistence projection for every non-card tool result. */
export function makeCompactToolDetails(input: CompactToolDetailsInput): CompactSubagentToolDetails {
  const runIds = input.runs?.slice(0, MAX_TARGET_RUNS).map((run) => clean(run.id, 128));
  const models = input.models?.slice(0, 32).map((model) => ({
    backend: model.backend,
    id: clean(model.id, 128),
  }));
  const profileIds = input.profileIds?.slice(0, 16).map((id) => clean(id, 64));
  const failures = input.actionFailures?.slice(0, MAX_TARGET_RUNS).map((failure) => ({
    id: clean(failure.id, 128),
    ...(failure.code ? { code: clean(failure.code, 64) } : {}),
    message: clean(failure.message, 256),
  }));
  const details: CompactSubagentToolDetails = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: clean(input.action, 32),
    ...(runIds && runIds.length > 0 ? { runIds, runCount: input.runs?.length } : {}),
    ...(models && models.length > 0
      ? { modelSelectors: models, modelCount: input.models?.length }
      : input.models
        ? { modelCount: input.models.length }
        : {}),
    ...(profileIds && profileIds.length > 0 ? { profileIds } : {}),
    ...(input.defaultProfile ? { defaultProfile: clean(input.defaultProfile, 64) } : {}),
    ...(failures && failures.length > 0 ? { actionFailures: failures } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.attentionRequired ? { attentionRequired: true } : {}),
  };
  if (serializedLength(details) <= MAX_TOOL_OUTPUT_CHARS) return freezeSnapshot(details);
  return freezeSnapshot({
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: clean(input.action, 32),
    ...(input.runs ? { runCount: input.runs.length } : {}),
    ...(input.models ? { modelCount: input.models.length } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.attentionRequired ? { attentionRequired: true } : {}),
  });
}

const RUN_STATES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "waiting_for_parent",
  "paused",
  "completed",
  "failed",
  "stopping",
  "stopped",
]);
const EFFORTS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const SOURCES: ReadonlySet<string> = new Set([
  "explicit",
  "profile-candidate",
  "profile-parent-candidate",
  "profile-parent-fallback",
]);

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const decodeSkipped = (value: unknown): ReadonlyArray<SkippedProfileCandidate> =>
  Array.isArray(value)
    ? value.slice(0, MAX_CARD_SKIPS).flatMap((entry) => {
        const record = recordOf(entry);
        if (
          !record ||
          typeof record.candidate !== "string" ||
          typeof record.code !== "string" ||
          typeof record.reason !== "string"
        )
          return [];
        const candidateIndex = finiteNumber(record.candidateIndex);
        return [
          {
            ...(candidateIndex === undefined ? {} : { candidateIndex }),
            candidate: clean(record.candidate, MAX_CARD_PROVENANCE_CHARS),
            code: clean(record.code, 128),
            reason: clean(record.reason, MAX_CARD_PROVENANCE_CHARS),
          },
        ];
      })
    : [];

const decodeSelection = (value: unknown): SubagentSelectionProvenance | undefined => {
  const record = recordOf(value);
  if (
    !record ||
    typeof record.source !== "string" ||
    !SOURCES.has(record.source) ||
    typeof record.reason !== "string"
  )
    return undefined;
  const candidateIndex = finiteNumber(record.candidateIndex);
  return {
    source: record.source as SubagentSelectionSource,
    ...(candidateIndex === undefined ? {} : { candidateIndex }),
    reason: clean(record.reason, MAX_CARD_PROVENANCE_CHARS),
    skippedCandidates: decodeSkipped(record.skippedCandidates),
    ...(typeof record.warning === "string"
      ? { warning: clean(record.warning, MAX_CARD_PROVENANCE_CHARS) }
      : {}),
  };
};

const decodeCard = (value: unknown): SubagentRunCard | undefined => {
  const record = recordOf(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    !record.id.trim() ||
    record.id.length > MAX_PROTOCOL_ID_CHARS ||
    typeof record.name !== "string" ||
    typeof record.state !== "string" ||
    !RUN_STATES.has(record.state) ||
    typeof record.model !== "string" ||
    typeof record.effort !== "string" ||
    !EFFORTS.has(record.effort)
  )
    return undefined;
  const selection = decodeSelection(record.selection);
  if (!selection) return undefined;
  const questionRecord = recordOf(record.question);
  return {
    id: clean(record.id.trim(), MAX_PROTOCOL_ID_CHARS),
    name: sanitizeName(record.name) || "subagent",
    state: record.state as SubagentRunState,
    ...(typeof record.profile === "string" && isProfileId(record.profile)
      ? { profile: record.profile }
      : {}),
    model: clean(record.model, MAX_CARD_MODEL_CHARS),
    effort: record.effort as SubagentEffort,
    selection,
    ...(typeof record.currentTool === "string"
      ? { currentTool: clean(record.currentTool, 256) }
      : {}),
    ...(finiteNumber(record.endedAt) === undefined
      ? {}
      : { endedAt: finiteNumber(record.endedAt) }),
    ...(typeof record.finalText === "string"
      ? { finalText: sanitizeOutputText(record.finalText, MAX_FINAL_TEXT_CHARS) }
      : {}),
    ...(typeof record.error === "string"
      ? { error: sanitizeOutputText(record.error, MAX_ERROR_CHARS) }
      : {}),
    ...(questionRecord && typeof questionRecord.message === "string"
      ? { question: { message: clean(questionRecord.message, MAX_CARD_QUESTION_CHARS) } }
      : {}),
  };
};

const decodeFailures = (value: unknown): ReadonlyArray<SubagentCardFailure> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const failures = value.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
    const record = recordOf(entry);
    if (record === undefined || typeof record.message !== "string") return [];
    const index = finiteNumber(record.index);
    return [
      {
        index: index === undefined ? 0 : Math.max(0, Math.floor(index)),
        ...(typeof record.name === "string" ? { name: sanitizeName(record.name) } : {}),
        message: clean(record.message, 512),
        ...(typeof record.code === "string" ? { code: clean(record.code, 128) } : {}),
      },
    ];
  });
  return failures.length > 0 ? failures : undefined;
};

/** Tolerant renderer boundary for current details and persisted legacy `{ action, runs }` data. */
export function decodeStartAwaitCardDetails(
  value: unknown,
): SubagentStartAwaitCardDetails | undefined {
  const record = recordOf(value);
  if (!record || (record.action !== "start" && record.action !== "await")) return undefined;
  const hasVersion = Object.prototype.hasOwnProperty.call(record, "version");
  if (hasVersion && record.version !== SUBAGENT_CARD_DETAILS_VERSION) return undefined;
  const source = hasVersion ? record.cards : record.runs;
  if (!Array.isArray(source)) return undefined;
  const cards = source.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
    const card = decodeCard(entry);
    return card ? [card] : [];
  });
  if (source.length > 0 && cards.length === 0) return undefined;
  return makeStartAwaitCardDetails({
    action: record.action,
    runs: cards,
    startFailures: decodeFailures(record.startFailures),
    ...(record.awaitUntil === "all_finished" || record.awaitUntil === "any_finished"
      ? { awaitUntil: record.awaitUntil }
      : {}),
    ...(record.timedOut === true ? { timedOut: true } : {}),
    ...(record.attentionRequired === true ? { attentionRequired: true } : {}),
    ...(record.cancelled === true ? { cancelled: true } : {}),
  });
}
