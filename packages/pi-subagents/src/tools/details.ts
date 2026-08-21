import * as Predicate from "effect/Predicate";

import { freezeSnapshot, stripTerminalControls } from "pi-cosmic-core";
import {
  SUBAGENT_EFFORTS,
  type SubagentContextMode,
  type SubagentEffort,
  type SubagentHost,
  type SubagentRuntime,
  type SubagentWriteIntent,
} from "../domain/routing.ts";
import type {
  PendingParentQuestion,
  SubagentCapability,
  SubagentRunState,
  SubagentRunView,
  SubagentUsage,
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
  normalizeProfileId,
  type ProfileId,
  type ProfileRouteSource,
  type SubagentSelectionProvenance,
} from "../profiles/model.ts";

export const SUBAGENT_CARD_DETAILS_VERSION = 1;
const CARD_STRING_BUDGET = 36_000;
export const MAX_CARD_MODEL_CHARS = 512;
export const MAX_CARD_PROVENANCE_CHARS = 1_024;
export const MAX_CARD_QUESTION_CHARS = 2_048;
export const MAX_CARD_SKIPS = 8;

export interface SubagentRunCard {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunState;
  readonly profile?: SubagentRunView["profile"] | undefined;
  readonly host?: SubagentRunView["host"] | undefined;
  readonly runtime?: SubagentRunView["runtime"] | undefined;
  readonly closeOnReport?: boolean | undefined;
  readonly reportGeneration: number;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly fastMode?: boolean | undefined;
  readonly context?: SubagentContextMode | undefined;
  readonly writeIntent?: SubagentWriteIntent | undefined;
  readonly capabilities?: ReadonlyArray<SubagentCapability> | undefined;
  readonly startedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly usage?: SubagentUsage | undefined;
  readonly selection: SubagentSelectionProvenance;
  readonly predecessorRunId?: string | undefined;
  readonly supersededByRunId?: string | undefined;
  readonly remainingCandidateCount?: number | undefined;
  readonly retryExhausted?: boolean | undefined;
  readonly retryBlocked?: boolean | undefined;
  readonly currentTool?: string | undefined;
  readonly progress?: string | undefined;
  readonly warning?: string | undefined;
  readonly endedAt?: number | undefined;
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly finalTextTruncated?: boolean | undefined;
  readonly errorTruncated?: boolean | undefined;
  readonly question?: Pick<PendingParentQuestion, "message"> | undefined;
}

export interface SubagentCardFailure {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
}

export interface SubagentStartEntry {
  readonly index: number;
  readonly name: string;
  /** Requested profile, retained even when an invalid raw request fails before resolution. */
  readonly profile: string;
  readonly status: "pending" | "started" | "failed";
  readonly routeStatus: "resolving" | "selected" | "unavailable";
  readonly host?: SubagentHost | undefined;
  readonly runtime?: SubagentRuntime | undefined;
  readonly model?: string | undefined;
  readonly effort?: SubagentEffort | undefined;
  readonly fastMode?: boolean | undefined;
  /** Zero-based selected fallback candidate index; shown only in expanded receipts. */
  readonly candidateIndex?: number | undefined;
  readonly runId?: string | undefined;
}

export interface SubagentProfileCandidateCard {
  readonly order: number;
  readonly candidate: string;
  readonly status: "eligible" | "skipped";
  readonly effectiveContext?: SubagentContextMode | undefined;
  readonly reason: string;
}

export interface SubagentProfileRouteCard {
  readonly id: ProfileId;
  readonly description: string;
  readonly source: ProfileRouteSource;
  readonly isDefault: boolean;
  readonly defaultContext: SubagentContextMode;
  readonly defaultWriteIntent: SubagentWriteIntent;
  readonly defaultEffort?: SubagentEffort | undefined;
  readonly candidates: ReadonlyArray<SubagentProfileCandidateCard>;
}

export interface SubagentStartAwaitCardDetails {
  readonly version: typeof SUBAGENT_CARD_DETAILS_VERSION;
  readonly action: "start" | "await";
  readonly cards: ReadonlyArray<SubagentRunCard>;
  readonly startEntries?: ReadonlyArray<SubagentStartEntry> | undefined;
  readonly startFailures?: ReadonlyArray<SubagentCardFailure> | undefined;
  readonly awaitUntil?: "all_finished" | "any_finished" | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  readonly contentOmitted?: boolean | undefined;
}

export interface CompactToolActionFailure {
  readonly id: string;
  readonly code?: string | undefined;
  readonly message: string;
}

export interface CompactSubagentToolDetails {
  readonly version: typeof SUBAGENT_CARD_DETAILS_VERSION;
  readonly action: string;
  readonly cards?: ReadonlyArray<SubagentRunCard> | undefined;
  readonly runIds?: ReadonlyArray<string> | undefined;
  readonly runCount?: number | undefined;
  readonly profiles?: ReadonlyArray<SubagentProfileRouteCard> | undefined;
  readonly profileIds?: ReadonlyArray<string> | undefined;
  readonly fallbackProfile?: string | undefined;
  readonly contentOmitted?: boolean | undefined;
  readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
}

export interface CompactToolDetailsInput {
  readonly action: string;
  readonly runs?: ReadonlyArray<SubagentRunView> | undefined;
  readonly includeReports?: boolean | undefined;
  readonly profiles?: ReadonlyArray<SubagentProfileRouteCard> | undefined;
  readonly profileIds?: ReadonlyArray<string> | undefined;
  readonly fallbackProfile?: string | undefined;
  readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
}

export interface StartAwaitDetailsInput {
  readonly action: "start" | "await";
  readonly runs: ReadonlyArray<SubagentRunCard>;
  readonly startEntries?: ReadonlyArray<SubagentStartEntry> | undefined;
  readonly startFailures?: ReadonlyArray<SubagentCardFailure> | undefined;
  readonly awaitUntil?: "all_finished" | "any_finished" | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  readonly contentOmitted?: boolean | undefined;
}

/** Shared wire sanitizer for versioned card details and their strict renderer decode. */
export const clean = (value: string, maximum: number): string =>
  safeTextPrefix(stripTerminalControls(value).replaceAll("\u0000", ""), maximum);
const cleanProfileId = (value: string): string => normalizeProfileId(value) ?? clean(value, 64);

const boundedSelection = (
  selection: SubagentSelectionProvenance,
  take: (value: string, maximum: number) => string,
): SubagentSelectionProvenance =>
  (() => {
    const baseResult = { source: selection.source };
    const withRouteSource = selection.routeSource
      ? { ...baseResult, routeSource: selection.routeSource }
      : baseResult;
    const withHost = selection.host
      ? { ...withRouteSource, host: selection.host }
      : withRouteSource;
    const withRuntime = selection.runtime ? { ...withHost, runtime: selection.runtime } : withHost;
    const withCloseOnReport =
      selection.closeOnReport === undefined
        ? withRuntime
        : { ...withRuntime, closeOnReport: selection.closeOnReport };
    const withCandidateIndex =
      selection.candidateIndex === undefined
        ? withCloseOnReport
        : { ...withCloseOnReport, candidateIndex: selection.candidateIndex };
    const withReasonAndSkippedCandidates = {
      ...withCandidateIndex,
      reason: take(selection.reason, MAX_CARD_PROVENANCE_CHARS),
      skippedCandidates: selection.skippedCandidates.slice(0, MAX_CARD_SKIPS).map((candidate) =>
        (() => {
          const baseResult = {};
          const withCandidateIndex =
            candidate.candidateIndex === undefined
              ? baseResult
              : { ...baseResult, candidateIndex: candidate.candidateIndex };
          const withCandidateAndAdditionalFields = {
            ...withCandidateIndex,
            candidate: take(candidate.candidate, MAX_CARD_PROVENANCE_CHARS),
            code: take(candidate.code, 128),
            reason: take(candidate.reason, MAX_CARD_PROVENANCE_CHARS),
          };
          return withCandidateAndAdditionalFields;
        })(),
      ),
    };
    const withWarning = selection.warning
      ? {
          ...withReasonAndSkippedCandidates,
          warning: take(selection.warning, MAX_CARD_PROVENANCE_CHARS),
        }
      : withReasonAndSkippedCandidates;
    return withWarning;
  })();

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
  const progress = run.progress ? take(run.progress, 512) : undefined;
  const warning = run.warning ? take(run.warning, 512) : undefined;
  const question = run.question
    ? { message: take(run.question.message, MAX_CARD_QUESTION_CHARS) }
    : undefined;
  const selection = boundedSelection(run.selection, take);
  const boundedFinalText = run.finalText
    ? sanitizeOutputText(run.finalText, MAX_FINAL_TEXT_CHARS)
    : undefined;
  const finalText = boundedFinalText ? take(boundedFinalText, MAX_FINAL_TEXT_CHARS) : undefined;
  const boundedError = run.error ? sanitizeOutputText(run.error, MAX_ERROR_CHARS) : undefined;
  const error = boundedError ? take(boundedError, MAX_ERROR_CHARS) : undefined;
  return (() => {
    const baseResult = { id, name, state: run.state };
    const withProfile = run.profile ? { ...baseResult, profile: run.profile } : baseResult;
    const withHost = run.host ? { ...withProfile, host: run.host } : withProfile;
    const withRuntime = run.runtime ? { ...withHost, runtime: run.runtime } : withHost;
    const withCloseOnReport =
      run.closeOnReport === undefined
        ? withRuntime
        : { ...withRuntime, closeOnReport: run.closeOnReport };
    const withReportGenerationAndAdditionalFields = {
      ...withCloseOnReport,
      reportGeneration: Math.max(0, Math.floor(run.reportGeneration)),
      model,
      effort: run.effort,
    };
    const withFastMode =
      run.fastMode === undefined
        ? withReportGenerationAndAdditionalFields
        : { ...withReportGenerationAndAdditionalFields, fastMode: run.fastMode };
    const withContext = run.context ? { ...withFastMode, context: run.context } : withFastMode;
    const withWriteIntent = run.writeIntent
      ? { ...withContext, writeIntent: run.writeIntent }
      : withContext;
    const withCapabilities = run.capabilities
      ? { ...withWriteIntent, capabilities: [...run.capabilities] }
      : withWriteIntent;
    const withStartedAt =
      run.startedAt === undefined
        ? withCapabilities
        : { ...withCapabilities, startedAt: boundedNonNegative(run.startedAt) };
    const withLastActivityAt =
      run.lastActivityAt === undefined
        ? withStartedAt
        : { ...withStartedAt, lastActivityAt: boundedNonNegative(run.lastActivityAt) };
    const withUsage = run.usage
      ? { ...withLastActivityAt, usage: boundedUsage(run.usage) }
      : withLastActivityAt;
    const withPredecessorRunId = run.predecessorRunId
      ? {
          ...withUsage,
          predecessorRunId: take(run.predecessorRunId, MAX_PROTOCOL_ID_CHARS),
        }
      : withUsage;
    const withSupersededByRunId = run.supersededByRunId
      ? {
          ...withPredecessorRunId,
          supersededByRunId: take(run.supersededByRunId, MAX_PROTOCOL_ID_CHARS),
        }
      : withPredecessorRunId;
    const withRemainingCandidateCount =
      run.remainingCandidateCount === undefined
        ? withSupersededByRunId
        : {
            ...withSupersededByRunId,
            remainingCandidateCount: boundedNonNegative(run.remainingCandidateCount),
          };
    const withRetryExhausted = run.retryExhausted
      ? { ...withRemainingCandidateCount, retryExhausted: true }
      : withRemainingCandidateCount;
    const withRetryBlocked = run.retryBlocked
      ? { ...withRetryExhausted, retryBlocked: true }
      : withRetryExhausted;
    const withCardSelection = { ...withRetryBlocked, selection };
    const withCurrentTool = currentTool ? { ...withCardSelection, currentTool } : withCardSelection;
    const withProgress = progress ? { ...withCurrentTool, progress } : withCurrentTool;
    const withWarning = warning ? { ...withProgress, warning } : withProgress;
    const withEndedAt =
      run.endedAt === undefined
        ? withWarning
        : { ...withWarning, endedAt: boundedNonNegative(run.endedAt) };
    const withFinalText = finalText ? { ...withEndedAt, finalText } : withEndedAt;
    const withError = error ? { ...withFinalText, error } : withFinalText;
    const withFinalTextTruncated =
      run.finalTextTruncated ||
      (boundedFinalText !== undefined && finalText?.length !== boundedFinalText.length)
        ? { ...withError, finalTextTruncated: true }
        : withError;
    const withErrorTruncated =
      run.errorTruncated || (boundedError !== undefined && error?.length !== boundedError.length)
        ? { ...withFinalTextTruncated, errorTruncated: true }
        : withFinalTextTruncated;
    const withQuestion = question?.message
      ? { ...withErrorTruncated, question }
      : withErrorTruncated;
    return withQuestion;
  })();
};

const projectFailures = (
  failures: ReadonlyArray<SubagentCardFailure> | undefined,
): ReadonlyArray<SubagentCardFailure> | undefined => {
  if (!failures || failures.length === 0) return undefined;
  return failures.slice(0, MAX_TARGET_RUNS).map((failure) =>
    (() => {
      const baseResult = {
        index: Number.isSafeInteger(failure.index) && failure.index >= 0 ? failure.index : 0,
      };
      const withName = failure.name
        ? { ...baseResult, name: sanitizeName(failure.name) }
        : baseResult;
      const withMessage = { ...withName, message: clean(failure.message, 512) };
      const withCode = failure.code
        ? { ...withMessage, code: clean(failure.code, 128) }
        : withMessage;
      return withCode;
    })(),
  );
};

const serializedLength = <ValueInput>(value: ValueInput): number => JSON.stringify(value).length;

export const boundedNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

/** Shared bounded usage normalization for versioned details and their strict renderer decode. */
export const boundedUsage = (usage: SubagentUsage): SubagentUsage =>
  (() => {
    const baseResult = {
      input: boundedNonNegative(usage.input),
      output: boundedNonNegative(usage.output),
      cacheRead: boundedNonNegative(usage.cacheRead),
      cacheWrite: boundedNonNegative(usage.cacheWrite),
      totalTokens: boundedNonNegative(usage.totalTokens),
    };
    const withCost =
      usage.cost === undefined
        ? baseResult
        : { ...baseResult, cost: boundedNonNegative(usage.cost) };
    return withCost;
  })();

const compactCardFallback = (card: SubagentRunCard): SubagentRunCard =>
  (() => {
    const baseResult = {
      id: clean(card.id, 128),
      name: clean(card.name, 96),
      state: card.state,
    };
    const withProfile = card.profile ? { ...baseResult, profile: card.profile } : baseResult;
    const withHost = card.host ? { ...withProfile, host: card.host } : withProfile;
    const withRuntime = card.runtime ? { ...withHost, runtime: card.runtime } : withHost;
    const withCloseOnReport =
      card.closeOnReport === undefined
        ? withRuntime
        : { ...withRuntime, closeOnReport: card.closeOnReport };
    const withReportGenerationAndAdditionalFields = {
      ...withCloseOnReport,
      reportGeneration: Math.max(0, Math.floor(card.reportGeneration)),
      model: clean(card.model, 96),
      effort: card.effort,
    };
    const withFastMode =
      card.fastMode === undefined
        ? withReportGenerationAndAdditionalFields
        : { ...withReportGenerationAndAdditionalFields, fastMode: card.fastMode };
    const withContext = card.context ? { ...withFastMode, context: card.context } : withFastMode;
    const withWriteIntent = card.writeIntent
      ? { ...withContext, writeIntent: card.writeIntent }
      : withContext;
    const withCapabilities = card.capabilities
      ? { ...withWriteIntent, capabilities: [...card.capabilities] }
      : withWriteIntent;
    const withStartedAt =
      card.startedAt === undefined
        ? withCapabilities
        : { ...withCapabilities, startedAt: card.startedAt };
    const withLastActivityAt =
      card.lastActivityAt === undefined
        ? withStartedAt
        : { ...withStartedAt, lastActivityAt: card.lastActivityAt };
    const withUsage = card.usage
      ? { ...withLastActivityAt, usage: boundedUsage(card.usage) }
      : withLastActivityAt;
    const withCardSelection = {
      ...withUsage,
      selection: (() => {
        const baseResult = { source: card.selection.source };
        const withHost = card.selection.host
          ? { ...baseResult, host: card.selection.host }
          : baseResult;
        const withRuntime = card.selection.runtime
          ? { ...withHost, runtime: card.selection.runtime }
          : withHost;
        const withCloseOnReport =
          card.selection.closeOnReport === undefined
            ? withRuntime
            : { ...withRuntime, closeOnReport: card.selection.closeOnReport };
        const withCandidateIndex =
          card.selection.candidateIndex === undefined
            ? withCloseOnReport
            : { ...withCloseOnReport, candidateIndex: card.selection.candidateIndex };
        const withReasonAndSkippedCandidates = {
          ...withCandidateIndex,
          reason: clean(card.selection.reason, 96),
          skippedCandidates: [],
        };
        return withReasonAndSkippedCandidates;
      })(),
    };
    const withCurrentTool = card.currentTool
      ? { ...withCardSelection, currentTool: clean(card.currentTool, 64) }
      : withCardSelection;
    const withProgress = card.progress
      ? { ...withCurrentTool, progress: clean(card.progress, 96) }
      : withCurrentTool;
    const withWarning = card.warning
      ? { ...withProgress, warning: clean(card.warning, 96) }
      : withProgress;
    const withEndedAt =
      card.endedAt === undefined ? withWarning : { ...withWarning, endedAt: card.endedAt };
    const withFinalTextTruncated = card.finalTextTruncated
      ? { ...withEndedAt, finalTextTruncated: true }
      : withEndedAt;
    const withErrorTruncated = card.errorTruncated
      ? { ...withFinalTextTruncated, errorTruncated: true }
      : withFinalTextTruncated;
    const withQuestion = card.question?.message
      ? { ...withErrorTruncated, question: { message: clean(card.question.message, 160) } }
      : withErrorTruncated;
    return withQuestion;
  })();

const compactFailureFallback = (failure: SubagentCardFailure): SubagentCardFailure =>
  (() => {
    const baseResult = { index: failure.index };
    const withName = failure.name ? { ...baseResult, name: clean(failure.name, 64) } : baseResult;
    const withMessage = { ...withName, message: clean(failure.message, 96) };
    const withCode = failure.code ? { ...withMessage, code: clean(failure.code, 48) } : withMessage;
    return withCode;
  })();

const projectStartEntries = (
  entries: ReadonlyArray<SubagentStartEntry> | undefined,
): ReadonlyArray<SubagentStartEntry> | undefined => {
  if (!entries || entries.length === 0) return undefined;
  return entries.slice(0, MAX_TARGET_RUNS).map((entry) => {
    const selected =
      entry.routeStatus === "selected" &&
      (entry.host === "local" || entry.host === "herdr") &&
      (entry.runtime === "pi" || entry.runtime === "claude" || entry.runtime === "codex") &&
      Predicate.isString(entry.model) &&
      clean(entry.model, MAX_CARD_MODEL_CHARS).length > 0 &&
      entry.effort !== undefined &&
      SUBAGENT_EFFORTS.includes(entry.effort);
    const routeStatus =
      entry.status === "pending" ? "resolving" : selected ? "selected" : "unavailable";
    const base: SubagentStartEntry = {
      index: Math.max(0, Math.floor(entry.index)),
      name: clean(entry.name, MAX_NAME_CHARS),
      profile: clean(entry.profile || "generalist", 64) || "generalist",
      status: entry.status,
      routeStatus,
    };
    const selectedBase = {
      host: entry.host,
      runtime: entry.runtime,
      model: clean(entry.model ?? "", MAX_CARD_MODEL_CHARS),
      effort: entry.effort,
    };
    const selectedFast = entry.fastMode
      ? { ...selectedBase, fastMode: true as const }
      : selectedBase;
    const selectedDetails =
      entry.candidateIndex === undefined
        ? selectedFast
        : {
            ...selectedFast,
            candidateIndex: Math.floor(boundedNonNegative(entry.candidateIndex)),
          };
    const withSelection = selected ? { ...base, ...selectedDetails } : base;
    return (
      entry.runId
        ? { ...withSelection, runId: clean(entry.runId, MAX_PROTOCOL_ID_CHARS) }
        : withSelection
    ) satisfies SubagentStartEntry;
  });
};

const compactStartEntryFallback = (
  entry: SubagentStartEntry,
  limits: {
    readonly name: number;
    readonly profile: number;
    readonly model: number;
    readonly id: number;
  },
): SubagentStartEntry =>
  (() => {
    const baseResult = {
      ...entry,
      name: clean(entry.name, limits.name),
      profile: clean(entry.profile, limits.profile) || "generalist",
    };
    const withModel =
      entry.model === undefined
        ? baseResult
        : { ...baseResult, model: clean(entry.model, limits.model) };
    const withRunId =
      entry.runId === undefined
        ? withModel
        : { ...withModel, runId: clean(entry.runId, limits.id) };
    return withRunId;
  })();

const projectProfiles = (
  profiles: ReadonlyArray<SubagentProfileRouteCard> | undefined,
): ReadonlyArray<SubagentProfileRouteCard> | undefined => {
  if (!profiles || profiles.length === 0) return undefined;
  return profiles.slice(0, 16).map((profile) =>
    (() => {
      const baseResult = {
        id: profile.id,
        description: clean(profile.description, 512),
        source: profile.source,
        isDefault: profile.isDefault,
        defaultContext: profile.defaultContext,
        defaultWriteIntent: profile.defaultWriteIntent,
      };
      const withDefaultEffort = profile.defaultEffort
        ? { ...baseResult, defaultEffort: profile.defaultEffort }
        : baseResult;
      const withCandidates = {
        ...withDefaultEffort,
        candidates: profile.candidates.slice(0, 32).map((candidate) =>
          (() => {
            const baseResult = {
              order: Math.max(1, Math.floor(candidate.order)),
              candidate: clean(candidate.candidate, 1_024),
              status: candidate.status,
            };
            const withEffectiveContext = candidate.effectiveContext
              ? { ...baseResult, effectiveContext: candidate.effectiveContext }
              : baseResult;
            const withReason = {
              ...withEffectiveContext,
              reason: clean(candidate.reason, 1_024),
            };
            return withReason;
          })(),
        ),
      };
      return withCandidates;
    })(),
  );
};

/** Versioned, deeply frozen, aggregate-bounded persistence projection for start/await cards. */
export function makeStartAwaitCardDetails(
  input: StartAwaitDetailsInput,
): SubagentStartAwaitCardDetails {
  const failures = projectFailures(input.startFailures);
  const startEntries = projectStartEntries(input.startEntries);
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
  const details: SubagentStartAwaitCardDetails = (() => {
    const baseResult: SubagentStartAwaitCardDetails = {
      version: SUBAGENT_CARD_DETAILS_VERSION,
      action: input.action,
      cards: cards.map((run) => projectCard(run, perCardBudget)),
    };
    const withStartEntries = startEntries ? { ...baseResult, startEntries } : baseResult;
    const withStartFailures = failures
      ? { ...withStartEntries, startFailures: failures }
      : withStartEntries;
    const withAwaitUntil = input.awaitUntil
      ? { ...withStartFailures, awaitUntil: input.awaitUntil }
      : withStartFailures;
    const withTimedOut = input.timedOut ? { ...withAwaitUntil, timedOut: true } : withAwaitUntil;
    const withAttentionRequired = input.attentionRequired
      ? { ...withTimedOut, attentionRequired: true }
      : withTimedOut;
    const withCancelled = input.cancelled
      ? { ...withAttentionRequired, cancelled: true }
      : withAttentionRequired;
    const withContentOmitted = input.contentOmitted
      ? { ...withCancelled, contentOmitted: true }
      : withCancelled;
    return withContentOmitted;
  })();
  // Raw string length is not a serialized bound: backslashes, controls, and lone surrogates can
  // expand several-fold under JSON.stringify. Recheck every fallback stage against the persisted
  // representation and finally drop optional card content rather than return an oversized value.
  const withoutReports: SubagentStartAwaitCardDetails = (() => {
    const baseResult = {
      ...details,
      cards: details.cards.map(
        ({ finalText: omittedFinalText, error: omittedError, ...card }): SubagentRunCard =>
          (() => {
            const baseResult = { ...card };
            const withFinalTextTruncated = omittedFinalText
              ? { ...baseResult, finalTextTruncated: true }
              : baseResult;
            const withErrorTruncated = omittedError
              ? { ...withFinalTextTruncated, errorTruncated: true }
              : withFinalTextTruncated;
            return withErrorTruncated;
          })(),
      ),
    };
    const withContentOmitted = details.cards.some((card) => card.finalText || card.error)
      ? { ...baseResult, contentOmitted: true }
      : baseResult;
    return withContentOmitted;
  })();
  const compactStartEntries = startEntries?.map((entry) =>
    compactStartEntryFallback(entry, { name: 64, profile: 48, model: 192, id: 96 }),
  );
  const minimalStartEntries = startEntries?.map((entry) =>
    compactStartEntryFallback(entry, { name: 48, profile: 24, model: 96, id: 32 }),
  );
  const compact: SubagentStartAwaitCardDetails = (() => {
    const baseResult = {
      ...withoutReports,
      cards: withoutReports.cards.map(compactCardFallback),
    };
    const withStartEntries = compactStartEntries
      ? { ...baseResult, startEntries: compactStartEntries }
      : baseResult;
    const withStartFailures = withoutReports.startFailures
      ? {
          ...withStartEntries,
          startFailures: withoutReports.startFailures.map(compactFailureFallback),
        }
      : withStartEntries;
    return withStartFailures;
  })();
  const minimal: SubagentStartAwaitCardDetails = (() => {
    const baseResult: SubagentStartAwaitCardDetails = {
      version: SUBAGENT_CARD_DETAILS_VERSION,
      action: input.action,
      cards: [],
    };
    const withStartEntries = minimalStartEntries
      ? { ...baseResult, startEntries: minimalStartEntries }
      : baseResult;
    const withStartFailures = failures
      ? { ...withStartEntries, startFailures: failures.map(compactFailureFallback) }
      : withStartEntries;
    const withAwaitUntil = input.awaitUntil
      ? { ...withStartFailures, awaitUntil: input.awaitUntil }
      : withStartFailures;
    const withTimedOut = input.timedOut ? { ...withAwaitUntil, timedOut: true } : withAwaitUntil;
    const withAttentionRequired = input.attentionRequired
      ? { ...withTimedOut, attentionRequired: true }
      : withTimedOut;
    const withCancelled = input.cancelled
      ? { ...withAttentionRequired, cancelled: true }
      : withAttentionRequired;
    const withContentOmitted =
      input.contentOmitted || details.cards.some((card) => card.finalText || card.error)
        ? { ...withCancelled, contentOmitted: true }
        : withCancelled;
    return withContentOmitted;
  })();
  const bounded = [details, withoutReports, compact, minimal].find(
    (candidate) => serializedLength(candidate) <= MAX_TOOL_OUTPUT_CHARS,
  );
  return freezeSnapshot(bounded ?? minimal);
}

/** Compact, versioned persistence projection for every non-start/await tool result. */
export function makeCompactToolDetails(input: CompactToolDetailsInput): CompactSubagentToolDetails {
  const sourceRuns = input.runs?.slice(0, MAX_TARGET_RUNS) ?? [];
  const runIds = sourceRuns.map((run) => clean(run.id, 128));
  const perCardBudget = Math.max(
    512,
    Math.floor(CARD_STRING_BUDGET / Math.max(1, sourceRuns.length)),
  );
  const cards: SubagentRunCard[] = sourceRuns.map((run): SubagentRunCard => {
    const card = projectCard(run, perCardBudget);
    if (input.includeReports) return card;
    const {
      finalText: _omittedFinalText,
      error: _omittedError,
      finalTextTruncated: _omittedFinalTextFlag,
      errorTruncated: _omittedErrorFlag,
      ...summary
    } = card;
    return summary;
  });
  const profiles = projectProfiles(input.profiles);
  const profileIds =
    input.profileIds?.slice(0, 16).map(cleanProfileId) ?? profiles?.map((profile) => profile.id);
  const failures = input.actionFailures?.slice(0, MAX_TARGET_RUNS).map((failure) =>
    (() => {
      const baseResult = { id: clean(failure.id, 128) };
      const withCode = failure.code ? { ...baseResult, code: clean(failure.code, 64) } : baseResult;
      const withMessage = { ...withCode, message: clean(failure.message, 256) };
      return withMessage;
    })(),
  );
  const base: CompactSubagentToolDetails = (() => {
    const baseResult: CompactSubagentToolDetails = {
      version: SUBAGENT_CARD_DETAILS_VERSION,
      action: clean(input.action, 32),
    };
    const withRunIdsAndRunCount =
      runIds.length > 0 ? { ...baseResult, runIds, runCount: input.runs?.length } : baseResult;
    const withProfiles = profiles ? { ...withRunIdsAndRunCount, profiles } : withRunIdsAndRunCount;
    const withProfileIds =
      profileIds && profileIds.length > 0 ? { ...withProfiles, profileIds } : withProfiles;
    const withFallbackProfile = input.fallbackProfile
      ? { ...withProfileIds, fallbackProfile: cleanProfileId(input.fallbackProfile) }
      : withProfileIds;
    const withActionFailures =
      failures && failures.length > 0
        ? { ...withFallbackProfile, actionFailures: failures }
        : withFallbackProfile;
    const withTimedOut = input.timedOut
      ? { ...withActionFailures, timedOut: true }
      : withActionFailures;
    const withAttentionRequired = input.attentionRequired
      ? { ...withTimedOut, attentionRequired: true }
      : withTimedOut;
    return withAttentionRequired;
  })();
  const details: CompactSubagentToolDetails = (() => {
    const baseResult = { ...base };
    const withCards = cards.length > 0 ? { ...baseResult, cards } : baseResult;
    return withCards;
  })();
  const withoutReports: CompactSubagentToolDetails = (() => {
    const baseResult = { ...details };
    const withCards =
      cards.length > 0
        ? {
            ...baseResult,
            cards: cards.map(
              ({ finalText: omittedFinalText, error: omittedError, ...card }): SubagentRunCard =>
                (() => {
                  const baseResult = { ...card };
                  const withFinalTextTruncated = omittedFinalText
                    ? { ...baseResult, finalTextTruncated: true }
                    : baseResult;
                  const withErrorTruncated = omittedError
                    ? { ...withFinalTextTruncated, errorTruncated: true }
                    : withFinalTextTruncated;
                  return withErrorTruncated;
                })(),
            ),
          }
        : baseResult;
    const withContentOmitted = cards.some((card) => card.finalText || card.error)
      ? { ...withCards, contentOmitted: true }
      : withCards;
    return withContentOmitted;
  })();
  const compact: CompactSubagentToolDetails = (() => {
    const baseResult = { ...withoutReports };
    const withCards = withoutReports.cards
      ? { ...baseResult, cards: withoutReports.cards.map(compactCardFallback) }
      : baseResult;
    return withCards;
  })();
  const minimal: CompactSubagentToolDetails = (() => {
    const baseResult: CompactSubagentToolDetails = {
      version: SUBAGENT_CARD_DETAILS_VERSION,
      action: clean(input.action, 32),
    };
    const withRunCount = input.runs ? { ...baseResult, runCount: input.runs.length } : baseResult;
    const withProfileIds =
      profileIds && profileIds.length > 0 ? { ...withRunCount, profileIds } : withRunCount;
    const withFallbackProfile = input.fallbackProfile
      ? { ...withProfileIds, fallbackProfile: cleanProfileId(input.fallbackProfile) }
      : withProfileIds;
    const withActionFailures =
      failures && failures.length > 0
        ? { ...withFallbackProfile, actionFailures: failures }
        : withFallbackProfile;
    const withTimedOut = input.timedOut
      ? { ...withActionFailures, timedOut: true }
      : withActionFailures;
    const withAttentionRequired = input.attentionRequired
      ? { ...withTimedOut, attentionRequired: true }
      : withTimedOut;
    const withContentOmitted = cards.some((card) => card.finalText || card.error)
      ? { ...withAttentionRequired, contentOmitted: true }
      : withAttentionRequired;
    return withContentOmitted;
  })();
  return freezeSnapshot(
    [details, withoutReports, compact, minimal].find(
      (candidate) => serializedLength(candidate) <= MAX_TOOL_OUTPUT_CHARS,
    ) ?? minimal,
  );
}
