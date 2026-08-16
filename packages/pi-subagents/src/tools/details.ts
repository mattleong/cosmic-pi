import { isStringValue } from "pi-cosmic-core";
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
    const objectPart6912_0 = { source: selection.source };
    const objectPart6912_1 = selection.routeSource
      ? { ...objectPart6912_0, routeSource: selection.routeSource }
      : objectPart6912_0;
    const objectPart6912_2 = selection.host
      ? { ...objectPart6912_1, host: selection.host }
      : objectPart6912_1;
    const objectPart6912_3 = selection.runtime
      ? { ...objectPart6912_2, runtime: selection.runtime }
      : objectPart6912_2;
    const objectPart6912_4 =
      selection.closeOnReport === undefined
        ? objectPart6912_3
        : { ...objectPart6912_3, closeOnReport: selection.closeOnReport };
    const objectPart6912_5 =
      selection.candidateIndex === undefined
        ? objectPart6912_4
        : { ...objectPart6912_4, candidateIndex: selection.candidateIndex };
    const objectPart6912_6 = {
      ...objectPart6912_5,
      reason: take(selection.reason, MAX_CARD_PROVENANCE_CHARS),
      skippedCandidates: selection.skippedCandidates.slice(0, MAX_CARD_SKIPS).map((candidate) =>
        (() => {
          const objectPart7487_0 = {};
          const objectPart7487_1 =
            candidate.candidateIndex === undefined
              ? objectPart7487_0
              : { ...objectPart7487_0, candidateIndex: candidate.candidateIndex };
          const objectPart7487_2 = {
            ...objectPart7487_1,
            candidate: take(candidate.candidate, MAX_CARD_PROVENANCE_CHARS),
            code: take(candidate.code, 128),
            reason: take(candidate.reason, MAX_CARD_PROVENANCE_CHARS),
          };
          return objectPart7487_2;
        })(),
      ),
    };
    const objectPart6912_7 = selection.warning
      ? { ...objectPart6912_6, warning: take(selection.warning, MAX_CARD_PROVENANCE_CHARS) }
      : objectPart6912_6;
    return objectPart6912_7;
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
    const objectPart9188_0 = { id, name, state: run.state };
    const objectPart9188_1 = run.profile
      ? { ...objectPart9188_0, profile: run.profile }
      : objectPart9188_0;
    const objectPart9188_2 = run.host ? { ...objectPart9188_1, host: run.host } : objectPart9188_1;
    const objectPart9188_3 = run.runtime
      ? { ...objectPart9188_2, runtime: run.runtime }
      : objectPart9188_2;
    const objectPart9188_4 =
      run.closeOnReport === undefined
        ? objectPart9188_3
        : { ...objectPart9188_3, closeOnReport: run.closeOnReport };
    const objectPart9188_5 = {
      ...objectPart9188_4,
      reportGeneration: Math.max(0, Math.floor(run.reportGeneration)),
      model,
      effort: run.effort,
    };
    const objectPart9188_6 =
      run.fastMode === undefined
        ? objectPart9188_5
        : { ...objectPart9188_5, fastMode: run.fastMode };
    const objectPart9188_7 = run.context
      ? { ...objectPart9188_6, context: run.context }
      : objectPart9188_6;
    const objectPart9188_8 = run.writeIntent
      ? { ...objectPart9188_7, writeIntent: run.writeIntent }
      : objectPart9188_7;
    const objectPart9188_9 = run.capabilities
      ? { ...objectPart9188_8, capabilities: [...run.capabilities] }
      : objectPart9188_8;
    const objectPart9188_10 =
      run.startedAt === undefined
        ? objectPart9188_9
        : { ...objectPart9188_9, startedAt: boundedNonNegative(run.startedAt) };
    const objectPart9188_11 =
      run.lastActivityAt === undefined
        ? objectPart9188_10
        : { ...objectPart9188_10, lastActivityAt: boundedNonNegative(run.lastActivityAt) };
    const objectPart9188_12 = run.usage
      ? { ...objectPart9188_11, usage: boundedUsage(run.usage) }
      : objectPart9188_11;
    const objectPart9188_13 = { ...objectPart9188_12, selection };
    const objectPart9188_14 = currentTool
      ? { ...objectPart9188_13, currentTool }
      : objectPart9188_13;
    const objectPart9188_15 = progress ? { ...objectPart9188_14, progress } : objectPart9188_14;
    const objectPart9188_16 = warning ? { ...objectPart9188_15, warning } : objectPart9188_15;
    const objectPart9188_17 =
      run.endedAt === undefined
        ? objectPart9188_16
        : { ...objectPart9188_16, endedAt: boundedNonNegative(run.endedAt) };
    const objectPart9188_18 = finalText ? { ...objectPart9188_17, finalText } : objectPart9188_17;
    const objectPart9188_19 = error ? { ...objectPart9188_18, error } : objectPart9188_18;
    const objectPart9188_20 =
      run.finalTextTruncated ||
      (boundedFinalText !== undefined && finalText?.length !== boundedFinalText.length)
        ? { ...objectPart9188_19, finalTextTruncated: true }
        : objectPart9188_19;
    const objectPart9188_21 =
      run.errorTruncated || (boundedError !== undefined && error?.length !== boundedError.length)
        ? { ...objectPart9188_20, errorTruncated: true }
        : objectPart9188_20;
    const objectPart9188_22 = question?.message
      ? { ...objectPart9188_21, question }
      : objectPart9188_21;
    return objectPart9188_22;
  })();
};

const projectFailures = (
  failures: ReadonlyArray<SubagentCardFailure> | undefined,
): ReadonlyArray<SubagentCardFailure> | undefined => {
  if (!failures || failures.length === 0) return undefined;
  return failures.slice(0, MAX_TARGET_RUNS).map((failure) =>
    (() => {
      const objectPart11049_0 = {
        index: Number.isSafeInteger(failure.index) && failure.index >= 0 ? failure.index : 0,
      };
      const objectPart11049_1 = failure.name
        ? { ...objectPart11049_0, name: sanitizeName(failure.name) }
        : objectPart11049_0;
      const objectPart11049_2 = { ...objectPart11049_1, message: clean(failure.message, 512) };
      const objectPart11049_3 = failure.code
        ? { ...objectPart11049_2, code: clean(failure.code, 128) }
        : objectPart11049_2;
      return objectPart11049_3;
    })(),
  );
};

const serializedLength = <ValueInput>(value: ValueInput): number => JSON.stringify(value).length;

export const boundedNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

/** Shared bounded usage normalization for versioned details and their strict renderer decode. */
export const boundedUsage = (usage: SubagentUsage): SubagentUsage =>
  (() => {
    const objectPart11682_0 = {
      input: boundedNonNegative(usage.input),
      output: boundedNonNegative(usage.output),
      cacheRead: boundedNonNegative(usage.cacheRead),
      cacheWrite: boundedNonNegative(usage.cacheWrite),
      totalTokens: boundedNonNegative(usage.totalTokens),
    };
    const objectPart11682_1 =
      usage.cost === undefined
        ? objectPart11682_0
        : { ...objectPart11682_0, cost: boundedNonNegative(usage.cost) };
    return objectPart11682_1;
  })();

const compactCardFallback = (card: SubagentRunCard): SubagentRunCard =>
  (() => {
    const objectPart13719_0 = {
      id: clean(card.id, 128),
      name: clean(card.name, 96),
      state: card.state,
    };
    const objectPart13719_1 = card.profile
      ? { ...objectPart13719_0, profile: card.profile }
      : objectPart13719_0;
    const objectPart13719_2 = card.host
      ? { ...objectPart13719_1, host: card.host }
      : objectPart13719_1;
    const objectPart13719_3 = card.runtime
      ? { ...objectPart13719_2, runtime: card.runtime }
      : objectPart13719_2;
    const objectPart13719_4 =
      card.closeOnReport === undefined
        ? objectPart13719_3
        : { ...objectPart13719_3, closeOnReport: card.closeOnReport };
    const objectPart13719_5 = {
      ...objectPart13719_4,
      reportGeneration: Math.max(0, Math.floor(card.reportGeneration)),
      model: clean(card.model, 96),
      effort: card.effort,
    };
    const objectPart13719_6 =
      card.fastMode === undefined
        ? objectPart13719_5
        : { ...objectPart13719_5, fastMode: card.fastMode };
    const objectPart13719_7 = card.context
      ? { ...objectPart13719_6, context: card.context }
      : objectPart13719_6;
    const objectPart13719_8 = card.writeIntent
      ? { ...objectPart13719_7, writeIntent: card.writeIntent }
      : objectPart13719_7;
    const objectPart13719_9 = card.capabilities
      ? { ...objectPart13719_8, capabilities: [...card.capabilities] }
      : objectPart13719_8;
    const objectPart13719_10 =
      card.startedAt === undefined
        ? objectPart13719_9
        : { ...objectPart13719_9, startedAt: card.startedAt };
    const objectPart13719_11 =
      card.lastActivityAt === undefined
        ? objectPart13719_10
        : { ...objectPart13719_10, lastActivityAt: card.lastActivityAt };
    const objectPart13719_12 = card.usage
      ? { ...objectPart13719_11, usage: boundedUsage(card.usage) }
      : objectPart13719_11;
    const objectPart13719_13 = {
      ...objectPart13719_12,
      selection: (() => {
        const objectPart13168_0 = { source: card.selection.source };
        const objectPart13168_1 = card.selection.host
          ? { ...objectPart13168_0, host: card.selection.host }
          : objectPart13168_0;
        const objectPart13168_2 = card.selection.runtime
          ? { ...objectPart13168_1, runtime: card.selection.runtime }
          : objectPart13168_1;
        const objectPart13168_3 =
          card.selection.closeOnReport === undefined
            ? objectPart13168_2
            : { ...objectPart13168_2, closeOnReport: card.selection.closeOnReport };
        const objectPart13168_4 =
          card.selection.candidateIndex === undefined
            ? objectPart13168_3
            : { ...objectPart13168_3, candidateIndex: card.selection.candidateIndex };
        const objectPart13168_5 = {
          ...objectPart13168_4,
          reason: clean(card.selection.reason, 96),
          skippedCandidates: [],
        };
        return objectPart13168_5;
      })(),
    };
    const objectPart13719_14 = card.currentTool
      ? { ...objectPart13719_13, currentTool: clean(card.currentTool, 64) }
      : objectPart13719_13;
    const objectPart13719_15 = card.progress
      ? { ...objectPart13719_14, progress: clean(card.progress, 96) }
      : objectPart13719_14;
    const objectPart13719_16 = card.warning
      ? { ...objectPart13719_15, warning: clean(card.warning, 96) }
      : objectPart13719_15;
    const objectPart13719_17 =
      card.endedAt === undefined
        ? objectPart13719_16
        : { ...objectPart13719_16, endedAt: card.endedAt };
    const objectPart13719_18 = card.finalTextTruncated
      ? { ...objectPart13719_17, finalTextTruncated: true }
      : objectPart13719_17;
    const objectPart13719_19 = card.errorTruncated
      ? { ...objectPart13719_18, errorTruncated: true }
      : objectPart13719_18;
    const objectPart13719_20 = card.question?.message
      ? { ...objectPart13719_19, question: { message: clean(card.question.message, 160) } }
      : objectPart13719_19;
    return objectPart13719_20;
  })();

const compactFailureFallback = (failure: SubagentCardFailure): SubagentCardFailure =>
  (() => {
    const objectPart14266_0 = { index: failure.index };
    const objectPart14266_1 = failure.name
      ? { ...objectPart14266_0, name: clean(failure.name, 64) }
      : objectPart14266_0;
    const objectPart14266_2 = { ...objectPart14266_1, message: clean(failure.message, 96) };
    const objectPart14266_3 = failure.code
      ? { ...objectPart14266_2, code: clean(failure.code, 48) }
      : objectPart14266_2;
    return objectPart14266_3;
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
      isStringValue(entry.model) &&
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
    const objectPart16252_0 = {
      ...entry,
      name: clean(entry.name, limits.name),
      profile: clean(entry.profile, limits.profile) || "generalist",
    };
    const objectPart16252_1 =
      entry.model === undefined
        ? objectPart16252_0
        : { ...objectPart16252_0, model: clean(entry.model, limits.model) };
    const objectPart16252_2 =
      entry.runId === undefined
        ? objectPart16252_1
        : { ...objectPart16252_1, runId: clean(entry.runId, limits.id) };
    return objectPart16252_2;
  })();

const projectProfiles = (
  profiles: ReadonlyArray<SubagentProfileRouteCard> | undefined,
): ReadonlyArray<SubagentProfileRouteCard> | undefined => {
  if (!profiles || profiles.length === 0) return undefined;
  return profiles.slice(0, 16).map((profile) =>
    (() => {
      const objectPart19203_0 = {
        id: profile.id,
        description: clean(profile.description, 512),
        source: profile.source,
        isDefault: profile.isDefault,
        defaultContext: profile.defaultContext,
        defaultWriteIntent: profile.defaultWriteIntent,
      };
      const objectPart19203_1 = profile.defaultEffort
        ? { ...objectPart19203_0, defaultEffort: profile.defaultEffort }
        : objectPart19203_0;
      const objectPart19203_2 = {
        ...objectPart19203_1,
        candidates: profile.candidates.slice(0, 32).map((candidate) =>
          (() => {
            const objectPart17181_0 = {
              order: Math.max(1, Math.floor(candidate.order)),
              candidate: clean(candidate.candidate, 1_024),
              status: candidate.status,
            };
            const objectPart17181_1 = candidate.effectiveContext
              ? { ...objectPart17181_0, effectiveContext: candidate.effectiveContext }
              : objectPart17181_0;
            const objectPart17181_2 = {
              ...objectPart17181_1,
              reason: clean(candidate.reason, 1_024),
            };
            return objectPart17181_2;
          })(),
        ),
      };
      return objectPart19203_2;
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
    const objectPart18249_0: SubagentStartAwaitCardDetails = {
      version: SUBAGENT_CARD_DETAILS_VERSION,
      action: input.action,
      cards: cards.map((run) => projectCard(run, perCardBudget)),
    };
    const objectPart18249_1 = startEntries
      ? { ...objectPart18249_0, startEntries }
      : objectPart18249_0;
    const objectPart18249_2 = failures
      ? { ...objectPart18249_1, startFailures: failures }
      : objectPart18249_1;
    const objectPart18249_3 = input.awaitUntil
      ? { ...objectPart18249_2, awaitUntil: input.awaitUntil }
      : objectPart18249_2;
    const objectPart18249_4 = input.timedOut
      ? { ...objectPart18249_3, timedOut: true }
      : objectPart18249_3;
    const objectPart18249_5 = input.attentionRequired
      ? { ...objectPart18249_4, attentionRequired: true }
      : objectPart18249_4;
    const objectPart18249_6 = input.cancelled
      ? { ...objectPart18249_5, cancelled: true }
      : objectPart18249_5;
    const objectPart18249_7 = input.contentOmitted
      ? { ...objectPart18249_6, contentOmitted: true }
      : objectPart18249_6;
    return objectPart18249_7;
  })();
  // Raw string length is not a serialized bound: backslashes, controls, and lone surrogates can
  // expand several-fold under JSON.stringify. Recheck every fallback stage against the persisted
  // representation and finally drop optional card content rather than return an oversized value.
  const withoutReports: SubagentStartAwaitCardDetails = (() => {
    const objectPart22115_0 = {
      ...details,
      cards: details.cards.map(
        ({ finalText: omittedFinalText, error: omittedError, ...card }): SubagentRunCard =>
          (() => {
            const objectPart19282_0 = { ...card };
            const objectPart19282_1 = omittedFinalText
              ? { ...objectPart19282_0, finalTextTruncated: true }
              : objectPart19282_0;
            const objectPart19282_2 = omittedError
              ? { ...objectPart19282_1, errorTruncated: true }
              : objectPart19282_1;
            return objectPart19282_2;
          })(),
      ),
    };
    const objectPart22115_1 = details.cards.some((card) => card.finalText || card.error)
      ? { ...objectPart22115_0, contentOmitted: true }
      : objectPart22115_0;
    return objectPart22115_1;
  })();
  const compactStartEntries = startEntries?.map((entry) =>
    compactStartEntryFallback(entry, { name: 64, profile: 48, model: 192, id: 96 }),
  );
  const minimalStartEntries = startEntries?.map((entry) =>
    compactStartEntryFallback(entry, { name: 48, profile: 24, model: 96, id: 32 }),
  );
  const compact: SubagentStartAwaitCardDetails = (() => {
    const objectPart19896_0 = {
      ...withoutReports,
      cards: withoutReports.cards.map(compactCardFallback),
    };
    const objectPart19896_1 = compactStartEntries
      ? { ...objectPart19896_0, startEntries: compactStartEntries }
      : objectPart19896_0;
    const objectPart19896_2 = withoutReports.startFailures
      ? {
          ...objectPart19896_1,
          startFailures: withoutReports.startFailures.map(compactFailureFallback),
        }
      : objectPart19896_1;
    return objectPart19896_2;
  })();
  const minimal: SubagentStartAwaitCardDetails = (() => {
    const objectPart20242_0: SubagentStartAwaitCardDetails = {
      version: SUBAGENT_CARD_DETAILS_VERSION,
      action: input.action,
      cards: [],
    };
    const objectPart20242_1 = minimalStartEntries
      ? { ...objectPart20242_0, startEntries: minimalStartEntries }
      : objectPart20242_0;
    const objectPart20242_2 = failures
      ? { ...objectPart20242_1, startFailures: failures.map(compactFailureFallback) }
      : objectPart20242_1;
    const objectPart20242_3 = input.awaitUntil
      ? { ...objectPart20242_2, awaitUntil: input.awaitUntil }
      : objectPart20242_2;
    const objectPart20242_4 = input.timedOut
      ? { ...objectPart20242_3, timedOut: true }
      : objectPart20242_3;
    const objectPart20242_5 = input.attentionRequired
      ? { ...objectPart20242_4, attentionRequired: true }
      : objectPart20242_4;
    const objectPart20242_6 = input.cancelled
      ? { ...objectPart20242_5, cancelled: true }
      : objectPart20242_5;
    const objectPart20242_7 =
      input.contentOmitted || details.cards.some((card) => card.finalText || card.error)
        ? { ...objectPart20242_6, contentOmitted: true }
        : objectPart20242_6;
    return objectPart20242_7;
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
      const objectPart22146_0 = { id: clean(failure.id, 128) };
      const objectPart22146_1 = failure.code
        ? { ...objectPart22146_0, code: clean(failure.code, 64) }
        : objectPart22146_0;
      const objectPart22146_2 = { ...objectPart22146_1, message: clean(failure.message, 256) };
      return objectPart22146_2;
    })(),
  );
  const base: CompactSubagentToolDetails = (() => {
    const objectPart22308_0: CompactSubagentToolDetails = {
      version: SUBAGENT_CARD_DETAILS_VERSION,
      action: clean(input.action, 32),
    };
    const objectPart22308_1 =
      runIds.length > 0
        ? { ...objectPart22308_0, runIds, runCount: input.runs?.length }
        : objectPart22308_0;
    const objectPart22308_2 = profiles ? { ...objectPart22308_1, profiles } : objectPart22308_1;
    const objectPart22308_3 =
      profileIds && profileIds.length > 0
        ? { ...objectPart22308_2, profileIds }
        : objectPart22308_2;
    const objectPart22308_4 = input.fallbackProfile
      ? { ...objectPart22308_3, fallbackProfile: cleanProfileId(input.fallbackProfile) }
      : objectPart22308_3;
    const objectPart22308_5 =
      failures && failures.length > 0
        ? { ...objectPart22308_4, actionFailures: failures }
        : objectPart22308_4;
    const objectPart22308_6 = input.timedOut
      ? { ...objectPart22308_5, timedOut: true }
      : objectPart22308_5;
    const objectPart22308_7 = input.attentionRequired
      ? { ...objectPart22308_6, attentionRequired: true }
      : objectPart22308_6;
    return objectPart22308_7;
  })();
  const details: CompactSubagentToolDetails = (() => {
    const objectPart22930_0 = { ...base };
    const objectPart22930_1 =
      cards.length > 0 ? { ...objectPart22930_0, cards } : objectPart22930_0;
    return objectPart22930_1;
  })();
  const withoutReports: CompactSubagentToolDetails = (() => {
    const objectPart27451_0 = { ...details };
    const objectPart27451_1 =
      cards.length > 0
        ? {
            ...objectPart27451_0,
            cards: cards.map(
              ({ finalText: omittedFinalText, error: omittedError, ...card }): SubagentRunCard =>
                (() => {
                  const objectPart23225_0 = { ...card };
                  const objectPart23225_1 = omittedFinalText
                    ? { ...objectPart23225_0, finalTextTruncated: true }
                    : objectPart23225_0;
                  const objectPart23225_2 = omittedError
                    ? { ...objectPart23225_1, errorTruncated: true }
                    : objectPart23225_1;
                  return objectPart23225_2;
                })(),
            ),
          }
        : objectPart27451_0;
    const objectPart27451_2 = cards.some((card) => card.finalText || card.error)
      ? { ...objectPart27451_1, contentOmitted: true }
      : objectPart27451_1;
    return objectPart27451_2;
  })();
  const compact: CompactSubagentToolDetails = (() => {
    const objectPart23584_0 = { ...withoutReports };
    const objectPart23584_1 = withoutReports.cards
      ? { ...objectPart23584_0, cards: withoutReports.cards.map(compactCardFallback) }
      : objectPart23584_0;
    return objectPart23584_1;
  })();
  const minimal: CompactSubagentToolDetails = (() => {
    const objectPart23755_0: CompactSubagentToolDetails = {
      version: SUBAGENT_CARD_DETAILS_VERSION,
      action: clean(input.action, 32),
    };
    const objectPart23755_1 = input.runs
      ? { ...objectPart23755_0, runCount: input.runs.length }
      : objectPart23755_0;
    const objectPart23755_2 =
      profileIds && profileIds.length > 0
        ? { ...objectPart23755_1, profileIds }
        : objectPart23755_1;
    const objectPart23755_3 = input.fallbackProfile
      ? { ...objectPart23755_2, fallbackProfile: cleanProfileId(input.fallbackProfile) }
      : objectPart23755_2;
    const objectPart23755_4 =
      failures && failures.length > 0
        ? { ...objectPart23755_3, actionFailures: failures }
        : objectPart23755_3;
    const objectPart23755_5 = input.timedOut
      ? { ...objectPart23755_4, timedOut: true }
      : objectPart23755_4;
    const objectPart23755_6 = input.attentionRequired
      ? { ...objectPart23755_5, attentionRequired: true }
      : objectPart23755_5;
    const objectPart23755_7 = cards.some((card) => card.finalText || card.error)
      ? { ...objectPart23755_6, contentOmitted: true }
      : objectPart23755_6;
    return objectPart23755_7;
  })();
  return freezeSnapshot(
    [details, withoutReports, compact, minimal].find(
      (candidate) => serializedLength(candidate) <= MAX_TOOL_OUTPUT_CHARS,
    ) ?? minimal,
  );
}
