import { freezeSnapshot, stripTerminalControls } from "pi-cosmic-core";
import {
  type PendingParentQuestion,
  type SubagentCapability,
  type SubagentContextMode,
  type SubagentEffort,
  type SubagentRunState,
  type SubagentRunView,
  type SubagentUsage,
  type SubagentWriteIntent,
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
  normalizeProfileId,
  type ProfileId,
  type ProfileRouteSource,
  type SubagentSelectionProvenance,
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
  readonly profile?: ProfileId | undefined;
  readonly status: "pending" | "started" | "failed";
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
  readonly defaultProfile?: string | undefined;
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
  readonly defaultProfile?: string | undefined;
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

const clean = (value: string, maximum: number): string =>
  safeTextPrefix(stripTerminalControls(value).replaceAll("\u0000", ""), maximum);
const cleanProfileId = (value: string): string => normalizeProfileId(value) ?? clean(value, 64);

const boundedSelection = (
  selection: SubagentSelectionProvenance,
  take: (value: string, maximum: number) => string,
): SubagentSelectionProvenance => ({
  source: selection.source,
  ...(selection.host ? { host: selection.host } : {}),
  ...(selection.runtime ? { runtime: selection.runtime } : {}),
  ...(selection.closeOnReport === undefined ? {} : { closeOnReport: selection.closeOnReport }),
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
  return {
    id,
    name,
    state: run.state,
    ...(run.profile ? { profile: run.profile } : {}),
    ...(run.host ? { host: run.host } : {}),
    ...(run.runtime ? { runtime: run.runtime } : {}),
    ...(run.closeOnReport === undefined ? {} : { closeOnReport: run.closeOnReport }),
    reportGeneration: Math.max(0, Math.floor(run.reportGeneration)),
    model,
    effort: run.effort,
    ...(run.fastMode === undefined ? {} : { fastMode: run.fastMode }),
    ...(run.context ? { context: run.context } : {}),
    ...(run.writeIntent ? { writeIntent: run.writeIntent } : {}),
    ...(run.capabilities ? { capabilities: [...run.capabilities] } : {}),
    ...(run.startedAt === undefined ? {} : { startedAt: boundedNonNegative(run.startedAt) }),
    ...(run.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: boundedNonNegative(run.lastActivityAt) }),
    ...(run.usage ? { usage: boundedUsage(run.usage) } : {}),
    selection,
    ...(currentTool ? { currentTool } : {}),
    ...(progress ? { progress } : {}),
    ...(warning ? { warning } : {}),
    ...(run.endedAt === undefined ? {} : { endedAt: boundedNonNegative(run.endedAt) }),
    ...(finalText ? { finalText } : {}),
    ...(error ? { error } : {}),
    ...(run.finalTextTruncated ||
    (boundedFinalText !== undefined && finalText?.length !== boundedFinalText.length)
      ? { finalTextTruncated: true }
      : {}),
    ...(run.errorTruncated || (boundedError !== undefined && error?.length !== boundedError.length)
      ? { errorTruncated: true }
      : {}),
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

const boundedNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

const boundedUsage = (usage: SubagentUsage): SubagentUsage => ({
  input: boundedNonNegative(usage.input),
  output: boundedNonNegative(usage.output),
  cacheRead: boundedNonNegative(usage.cacheRead),
  cacheWrite: boundedNonNegative(usage.cacheWrite),
  totalTokens: boundedNonNegative(usage.totalTokens),
  cost: boundedNonNegative(usage.cost),
});

const compactCardFallback = (card: SubagentRunCard): SubagentRunCard => ({
  id: clean(card.id, 128),
  name: clean(card.name, 96),
  state: card.state,
  ...(card.profile ? { profile: card.profile } : {}),
  ...(card.host ? { host: card.host } : {}),
  ...(card.runtime ? { runtime: card.runtime } : {}),
  ...(card.closeOnReport === undefined ? {} : { closeOnReport: card.closeOnReport }),
  reportGeneration: Math.max(0, Math.floor(card.reportGeneration)),
  model: clean(card.model, 96),
  effort: card.effort,
  ...(card.fastMode === undefined ? {} : { fastMode: card.fastMode }),
  ...(card.context ? { context: card.context } : {}),
  ...(card.writeIntent ? { writeIntent: card.writeIntent } : {}),
  ...(card.startedAt === undefined ? {} : { startedAt: card.startedAt }),
  ...(card.lastActivityAt === undefined ? {} : { lastActivityAt: card.lastActivityAt }),
  ...(card.usage ? { usage: boundedUsage(card.usage) } : {}),
  selection: {
    source: card.selection.source,
    ...(card.selection.host ? { host: card.selection.host } : {}),
    ...(card.selection.runtime ? { runtime: card.selection.runtime } : {}),
    ...(card.selection.closeOnReport === undefined
      ? {}
      : { closeOnReport: card.selection.closeOnReport }),
    ...(card.selection.candidateIndex === undefined
      ? {}
      : { candidateIndex: card.selection.candidateIndex }),
    reason: clean(card.selection.reason, 96),
    skippedCandidates: [],
  },
  ...(card.currentTool ? { currentTool: clean(card.currentTool, 64) } : {}),
  ...(card.progress ? { progress: clean(card.progress, 96) } : {}),
  ...(card.warning ? { warning: clean(card.warning, 96) } : {}),
  ...(card.endedAt === undefined ? {} : { endedAt: card.endedAt }),
  ...(card.finalTextTruncated ? { finalTextTruncated: true } : {}),
  ...(card.errorTruncated ? { errorTruncated: true } : {}),
  ...(card.question?.message ? { question: { message: clean(card.question.message, 160) } } : {}),
});

const compactFailureFallback = (failure: SubagentCardFailure): SubagentCardFailure => ({
  index: failure.index,
  ...(failure.name ? { name: clean(failure.name, 64) } : {}),
  message: clean(failure.message, 96),
  ...(failure.code ? { code: clean(failure.code, 48) } : {}),
});

const projectStartEntries = (
  entries: ReadonlyArray<SubagentStartEntry> | undefined,
): ReadonlyArray<SubagentStartEntry> | undefined => {
  if (!entries || entries.length === 0) return undefined;
  return entries.slice(0, MAX_TARGET_RUNS).map((entry) => ({
    index: Math.max(0, Math.floor(entry.index)),
    name: clean(entry.name, MAX_NAME_CHARS),
    ...(entry.profile && isProfileId(entry.profile) ? { profile: entry.profile } : {}),
    status: entry.status,
    ...(entry.runId ? { runId: clean(entry.runId, MAX_PROTOCOL_ID_CHARS) } : {}),
  }));
};

const projectProfiles = (
  profiles: ReadonlyArray<SubagentProfileRouteCard> | undefined,
): ReadonlyArray<SubagentProfileRouteCard> | undefined => {
  if (!profiles || profiles.length === 0) return undefined;
  return profiles.slice(0, 16).map((profile) => ({
    id: profile.id,
    description: clean(profile.description, 512),
    source: profile.source,
    isDefault: profile.isDefault,
    defaultContext: profile.defaultContext,
    defaultWriteIntent: profile.defaultWriteIntent,
    ...(profile.defaultEffort ? { defaultEffort: profile.defaultEffort } : {}),
    candidates: profile.candidates.slice(0, 32).map((candidate) => ({
      order: Math.max(1, Math.floor(candidate.order)),
      candidate: clean(candidate.candidate, 1_024),
      status: candidate.status,
      ...(candidate.effectiveContext ? { effectiveContext: candidate.effectiveContext } : {}),
      reason: clean(candidate.reason, 1_024),
    })),
  }));
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
  const details: SubagentStartAwaitCardDetails = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: input.action,
    cards: cards.map((run) => projectCard(run, perCardBudget)),
    ...(startEntries ? { startEntries } : {}),
    ...(failures ? { startFailures: failures } : {}),
    ...(input.awaitUntil ? { awaitUntil: input.awaitUntil } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.attentionRequired ? { attentionRequired: true } : {}),
    ...(input.cancelled ? { cancelled: true } : {}),
    ...(input.contentOmitted ? { contentOmitted: true } : {}),
  };
  // Raw string length is not a serialized bound: backslashes, controls, and lone surrogates can
  // expand several-fold under JSON.stringify. Recheck every fallback stage against the persisted
  // representation and finally drop optional card content rather than return an oversized value.
  const withoutReports: SubagentStartAwaitCardDetails = {
    ...details,
    cards: details.cards.map(
      ({ finalText: omittedFinalText, error: omittedError, ...card }): SubagentRunCard => ({
        ...card,
        ...(omittedFinalText ? { finalTextTruncated: true } : {}),
        ...(omittedError ? { errorTruncated: true } : {}),
      }),
    ),
    ...(details.cards.some((card) => card.finalText || card.error) ? { contentOmitted: true } : {}),
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
    ...(startEntries ? { startEntries } : {}),
    ...(input.awaitUntil ? { awaitUntil: input.awaitUntil } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.attentionRequired ? { attentionRequired: true } : {}),
    ...(input.cancelled ? { cancelled: true } : {}),
    ...(input.contentOmitted || details.cards.some((card) => card.finalText || card.error)
      ? { contentOmitted: true }
      : {}),
  };
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
  const failures = input.actionFailures?.slice(0, MAX_TARGET_RUNS).map((failure) => ({
    id: clean(failure.id, 128),
    ...(failure.code ? { code: clean(failure.code, 64) } : {}),
    message: clean(failure.message, 256),
  }));
  const base = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: clean(input.action, 32),
    ...(runIds.length > 0 ? { runIds, runCount: input.runs?.length } : {}),
    ...(profiles ? { profiles } : {}),
    ...(profileIds && profileIds.length > 0 ? { profileIds } : {}),
    ...(input.defaultProfile ? { defaultProfile: cleanProfileId(input.defaultProfile) } : {}),
    ...(failures && failures.length > 0 ? { actionFailures: failures } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.attentionRequired ? { attentionRequired: true } : {}),
  } as const;
  const details: CompactSubagentToolDetails = {
    ...base,
    ...(cards.length > 0 ? { cards } : {}),
  };
  const withoutReports: CompactSubagentToolDetails = {
    ...details,
    ...(cards.length > 0
      ? {
          cards: cards.map(
            ({ finalText: omittedFinalText, error: omittedError, ...card }): SubagentRunCard => ({
              ...card,
              ...(omittedFinalText ? { finalTextTruncated: true } : {}),
              ...(omittedError ? { errorTruncated: true } : {}),
            }),
          ),
        }
      : {}),
    ...(cards.some((card) => card.finalText || card.error) ? { contentOmitted: true } : {}),
  };
  const compact: CompactSubagentToolDetails = {
    ...withoutReports,
    ...(withoutReports.cards ? { cards: withoutReports.cards.map(compactCardFallback) } : {}),
  };
  const minimal: CompactSubagentToolDetails = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: clean(input.action, 32),
    ...(input.runs ? { runCount: input.runs.length } : {}),
    ...(profileIds && profileIds.length > 0 ? { profileIds } : {}),
    ...(input.defaultProfile ? { defaultProfile: cleanProfileId(input.defaultProfile) } : {}),
    ...(failures && failures.length > 0 ? { actionFailures: failures } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.attentionRequired ? { attentionRequired: true } : {}),
    ...(cards.some((card) => card.finalText || card.error) ? { contentOmitted: true } : {}),
  };
  return freezeSnapshot(
    [details, withoutReports, compact, minimal].find(
      (candidate) => serializedLength(candidate) <= MAX_TOOL_OUTPUT_CHARS,
    ) ?? minimal,
  );
}
