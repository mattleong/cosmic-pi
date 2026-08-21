import * as Predicate from "effect/Predicate";
import type { JsonObject } from "pi-cosmic-core";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { freezeSnapshot, isJsonObject } from "pi-cosmic-core";
import {
  SUBAGENT_EFFORTS,
  type SubagentEffort,
  type SubagentHost,
  type SubagentRuntime,
} from "../domain/routing.ts";
import {
  SUBAGENT_RUN_STATES,
  type SubagentCapability,
  type SubagentRunState,
  type SubagentUsage,
} from "../run/model.ts";
import { MAX_PROTOCOL_ID_CHARS, MAX_TARGET_RUNS } from "../run/limits.ts";
import {
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  MAX_NAME_CHARS,
  sanitizeName,
  sanitizeOutputText,
} from "../run/state.ts";
import {
  normalizeProfileId,
  type ProfileRouteSource,
  type SkippedProfileCandidate,
  type SubagentSelectionProvenance,
  type SubagentSelectionSource,
} from "../profiles/model.ts";
import {
  MAX_CARD_MODEL_CHARS,
  MAX_CARD_PROVENANCE_CHARS,
  MAX_CARD_QUESTION_CHARS,
  MAX_CARD_SKIPS,
  SUBAGENT_CARD_DETAILS_VERSION,
  boundedNonNegative,
  boundedUsage,
  clean,
  makeStartAwaitCardDetails,
  type CompactSubagentToolDetails,
  type CompactToolActionFailure,
  type SubagentCardFailure,
  type SubagentProfileCandidateCard,
  type SubagentProfileRouteCard,
  type SubagentRunCard,
  type SubagentStartAwaitCardDetails,
  type SubagentStartEntry,
} from "./details.ts";

type MutableSubagentRunCard = {
  -readonly [Key in keyof SubagentRunCard]: SubagentRunCard[Key];
};
interface DecodedProfileCandidate {
  order: number;
  candidate: string;
  status: SubagentProfileCandidateCard["status"];
  effectiveContext?: SubagentProfileCandidateCard["effectiveContext"];
  reason: string;
}
interface DecodedProfileRoute {
  id: SubagentProfileRouteCard["id"];
  description: string;
  source: SubagentProfileRouteCard["source"];
  isDefault: boolean;
  defaultContext: SubagentProfileRouteCard["defaultContext"];
  defaultWriteIntent: SubagentProfileRouteCard["defaultWriteIntent"];
  defaultEffort?: SubagentProfileRouteCard["defaultEffort"];
  candidates: ReadonlyArray<SubagentProfileCandidateCard>;
}
type MutableStartAwaitDetails = {
  -readonly [Key in keyof Parameters<typeof makeStartAwaitCardDetails>[0]]: Parameters<
    typeof makeStartAwaitCardDetails
  >[0][Key];
};

const isRunState = <Value>(value: Value): value is Value & SubagentRunState =>
  Predicate.isString(value) && SUBAGENT_RUN_STATES.some((state) => state === value);
const isEffort = <Value>(value: Value): value is Value & SubagentEffort =>
  Predicate.isString(value) && SUBAGENT_EFFORTS.some((effort) => effort === value);
const CAPABILITIES: ReadonlySet<string> = new Set([
  "steer",
  "interrupt",
  "resume",
  "rename-display",
  "parent-contact",
  "peer-notice",
  "native-fork",
]);
const PROFILE_SOURCES = [
  "session",
  "project",
  "project-invalid",
  "global",
  "global-invalid",
  "builtin",
] as const satisfies ReadonlyArray<ProfileRouteSource>;
const isProfileRouteSource = <Value>(value: Value): value is Value & ProfileRouteSource =>
  Predicate.isString(value) && PROFILE_SOURCES.some((source) => source === value);
const isSelectionSource = <Value>(value: Value): value is Value & SubagentSelectionSource =>
  value === "profile-candidate" || value === "profile-parent-candidate";

const recordOf = <ValueInput>(value: ValueInput): Readonly<JsonObject> | undefined =>
  isJsonObject(value) ? value : undefined;
const finiteNumber = <ValueInput>(value: ValueInput): number | undefined =>
  Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;

const decodeUsage = <ValueInput>(value: ValueInput): SubagentUsage | undefined => {
  const record = recordOf(value);
  if (!record) return undefined;
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
  if (fields.some((field) => finiteNumber(record[field]) === undefined)) return undefined;
  // Cost stays optional: absence means unknown and is preserved rather than becoming $0.
  if (record.cost !== undefined && finiteNumber(record.cost) === undefined) return undefined;
  const cost = finiteNumber(record.cost);
  return boundedUsage(
    (() => {
      const baseResult = {
        input: finiteNumber(record.input) ?? 0,
        output: finiteNumber(record.output) ?? 0,
        cacheRead: finiteNumber(record.cacheRead) ?? 0,
        cacheWrite: finiteNumber(record.cacheWrite) ?? 0,
        totalTokens: finiteNumber(record.totalTokens) ?? 0,
      };
      const withCost = cost === undefined ? baseResult : { ...baseResult, cost };
      return withCost;
    })(),
  );
};

const decodeSkipped = <ValueInput>(value: ValueInput): ReadonlyArray<SkippedProfileCandidate> =>
  Array.isArray(value)
    ? value.slice(0, MAX_CARD_SKIPS).flatMap((entry) => {
        const record = recordOf(entry);
        if (
          !record ||
          !Predicate.isString(record.candidate) ||
          !Predicate.isString(record.code) ||
          !Predicate.isString(record.reason)
        )
          return [];
        const candidateIndex = finiteNumber(record.candidateIndex);
        return [
          (() => {
            const baseResult = {};
            const withCandidateIndex =
              candidateIndex === undefined ? baseResult : { ...baseResult, candidateIndex };
            const withCandidateAndAdditionalFields = {
              ...withCandidateIndex,
              candidate: clean(record.candidate, MAX_CARD_PROVENANCE_CHARS),
              code: clean(record.code, 128),
              reason: clean(record.reason, MAX_CARD_PROVENANCE_CHARS),
            };
            return withCandidateAndAdditionalFields;
          })(),
        ];
      })
    : [];

const decodeSelection = <ValueInput>(
  value: ValueInput,
): SubagentSelectionProvenance | undefined => {
  const record = recordOf(value);
  if (!record || !isSelectionSource(record.source) || !Predicate.isString(record.reason))
    return undefined;
  const candidateIndex = finiteNumber(record.candidateIndex);
  let selection: SubagentSelectionProvenance = {
    source: record.source,
    reason: clean(record.reason, MAX_CARD_PROVENANCE_CHARS),
    skippedCandidates: decodeSkipped(record.skippedCandidates),
  };
  if (isProfileRouteSource(record.routeSource))
    selection = { ...selection, routeSource: record.routeSource };
  if (record.host === "local" || record.host === "herdr")
    selection = { ...selection, host: record.host };
  if (record.runtime === "pi" || record.runtime === "claude" || record.runtime === "codex")
    selection = { ...selection, runtime: record.runtime };
  if (Predicate.isBoolean(record.closeOnReport))
    selection = { ...selection, closeOnReport: record.closeOnReport };
  if (candidateIndex !== undefined) selection = { ...selection, candidateIndex };
  if (Predicate.isString(record.warning))
    selection = { ...selection, warning: clean(record.warning, MAX_CARD_PROVENANCE_CHARS) };
  return selection;
};

const decodeCard = <ValueInput>(value: ValueInput): SubagentRunCard | undefined => {
  const record = recordOf(value);
  if (
    !record ||
    !Predicate.isString(record.id) ||
    !record.id.trim() ||
    record.id.length > MAX_PROTOCOL_ID_CHARS ||
    !Predicate.isString(record.name) ||
    !isRunState(record.state) ||
    !Predicate.isString(record.model) ||
    !isEffort(record.effort)
  )
    return undefined;
  const selection = decodeSelection(record.selection);
  if (!selection) return undefined;
  const questionRecord = recordOf(record.question);
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter(
        (capability): capability is SubagentCapability =>
          Predicate.isString(capability) && CAPABILITIES.has(capability),
      )
    : undefined;
  const usage = decodeUsage(record.usage);
  const profile = Predicate.isString(record.profile)
    ? normalizeProfileId(record.profile)
    : undefined;
  const card: MutableSubagentRunCard = {
    id: clean(record.id.trim(), MAX_PROTOCOL_ID_CHARS),
    name: sanitizeName(record.name) || "subagent",
    state: record.state,
    reportGeneration: Math.max(0, Math.floor(finiteNumber(record.reportGeneration) ?? 0)),
    model: clean(record.model, MAX_CARD_MODEL_CHARS),
    effort: record.effort,
    selection,
  };
  if (profile) card.profile = profile;
  if (record.host === "local" || record.host === "herdr") card.host = record.host;
  if (record.runtime === "pi" || record.runtime === "claude" || record.runtime === "codex")
    card.runtime = record.runtime;
  if (Predicate.isBoolean(record.closeOnReport)) card.closeOnReport = record.closeOnReport;
  if (Predicate.isBoolean(record.fastMode)) card.fastMode = record.fastMode;
  if (record.context === "fresh" || record.context === "fork") card.context = record.context;
  if (record.writeIntent === "read-only" || record.writeIntent === "writer")
    card.writeIntent = record.writeIntent;
  if (capabilities) card.capabilities = capabilities;
  const startedAt = finiteNumber(record.startedAt);
  if (startedAt !== undefined) card.startedAt = boundedNonNegative(startedAt);
  const lastActivityAt = finiteNumber(record.lastActivityAt);
  if (lastActivityAt !== undefined) card.lastActivityAt = boundedNonNegative(lastActivityAt);
  if (usage) card.usage = usage;
  if (Predicate.isString(record.predecessorRunId))
    card.predecessorRunId = clean(record.predecessorRunId, MAX_PROTOCOL_ID_CHARS);
  if (Predicate.isString(record.supersededByRunId))
    card.supersededByRunId = clean(record.supersededByRunId, MAX_PROTOCOL_ID_CHARS);
  const remainingCandidateCount = finiteNumber(record.remainingCandidateCount);
  if (remainingCandidateCount !== undefined)
    card.remainingCandidateCount = boundedNonNegative(remainingCandidateCount);
  if (record.retryExhausted === true) card.retryExhausted = true;
  if (record.retryBlocked === true) card.retryBlocked = true;
  if (Predicate.isString(record.currentTool)) card.currentTool = clean(record.currentTool, 256);
  if (Predicate.isString(record.progress)) card.progress = clean(record.progress, 512);
  if (Predicate.isString(record.warning)) card.warning = clean(record.warning, 512);
  const endedAt = finiteNumber(record.endedAt);
  if (endedAt !== undefined) card.endedAt = endedAt;
  if (Predicate.isString(record.finalText))
    card.finalText = sanitizeOutputText(record.finalText, MAX_FINAL_TEXT_CHARS);
  if (Predicate.isString(record.error))
    card.error = sanitizeOutputText(record.error, MAX_ERROR_CHARS);
  if (record.finalTextTruncated === true) card.finalTextTruncated = true;
  if (record.errorTruncated === true) card.errorTruncated = true;
  if (questionRecord && Predicate.isString(questionRecord.message))
    card.question = { message: clean(questionRecord.message, MAX_CARD_QUESTION_CHARS) };
  return card;
};

const decodeFailures = <ValueInput>(
  value: ValueInput,
): ReadonlyArray<SubagentCardFailure> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const failures = value.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
    const record = recordOf(entry);
    if (record === undefined || !Predicate.isString(record.message)) return [];
    const index = finiteNumber(record.index);
    return [
      (() => {
        const baseResult = {
          index: index === undefined ? 0 : Math.max(0, Math.floor(index)),
        };
        const withName = Predicate.isString(record.name)
          ? { ...baseResult, name: sanitizeName(record.name) }
          : baseResult;
        const withMessage = { ...withName, message: clean(record.message, 512) };
        const withCode = Predicate.isString(record.code)
          ? { ...withMessage, code: clean(record.code, 128) }
          : withMessage;
        return withCode;
      })(),
    ];
  });
  return failures.length > 0 ? failures : undefined;
};

const decodeStartEntries = <ValueInput>(
  value: ValueInput,
): ReadonlyArray<SubagentStartEntry> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
    const record = recordOf(entry);
    const index = record ? finiteNumber(record.index) : undefined;
    if (
      !record ||
      index === undefined ||
      !Predicate.isString(record.name) ||
      (record.status !== "pending" && record.status !== "started" && record.status !== "failed")
    )
      return [];
    const selected =
      record.routeStatus === "selected" &&
      (record.host === "local" || record.host === "herdr") &&
      (record.runtime === "pi" || record.runtime === "claude" || record.runtime === "codex") &&
      Predicate.isString(record.model) &&
      clean(record.model, MAX_CARD_MODEL_CHARS).length > 0 &&
      Predicate.isString(record.effort) &&
      isEffort(record.effort);
    const routeStatus =
      record.status === "pending" ? "resolving" : selected ? "selected" : "unavailable";
    const candidateIndex = finiteNumber(record.candidateIndex);
    const base: SubagentStartEntry = {
      index: Math.max(0, Math.floor(index)),
      name: clean(record.name, MAX_NAME_CHARS),
      profile:
        (Predicate.isString(record.profile) ? clean(record.profile, 64) : "") || "generalist",
      status: record.status,
      routeStatus,
    };
    const withSelection = selected
      ? (() => {
          // SAFETY: The selected-route checks above validate every narrowed route field.
          const selectionBase = {
            host: record.host as SubagentHost,
            runtime: record.runtime as SubagentRuntime,
            model: clean(record.model as string, MAX_CARD_MODEL_CHARS),
            effort: record.effort as SubagentEffort,
          };
          const selectionFast =
            record.fastMode === true
              ? { ...selectionBase, fastMode: true as const }
              : selectionBase;
          const selection =
            candidateIndex === undefined
              ? selectionFast
              : { ...selectionFast, candidateIndex: Math.max(0, Math.floor(candidateIndex)) };
          return { ...base, ...selection };
        })()
      : base;
    return [
      (Predicate.isString(record.runId)
        ? { ...withSelection, runId: clean(record.runId, MAX_PROTOCOL_ID_CHARS) }
        : withSelection) satisfies SubagentStartEntry,
    ];
  });
  return entries.length > 0 ? entries : undefined;
};

const decodeProfiles = <ValueInput>(
  value: ValueInput,
): ReadonlyArray<SubagentProfileRouteCard> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const profiles = value.slice(0, 16).flatMap((entry) => {
    const record = recordOf(entry);
    const profile =
      record && Predicate.isString(record.id) ? normalizeProfileId(record.id) : undefined;
    if (
      !record ||
      !profile ||
      !Predicate.isString(record.description) ||
      !Predicate.isString(record.source) ||
      !isProfileRouteSource(record.source) ||
      !Predicate.isBoolean(record.isDefault) ||
      (record.defaultContext !== "fresh" && record.defaultContext !== "fork") ||
      (record.defaultWriteIntent !== "read-only" && record.defaultWriteIntent !== "writer") ||
      !Array.isArray(record.candidates)
    )
      return [];
    const candidates = record.candidates.slice(0, 32).flatMap((value) => {
      const candidate = recordOf(value);
      const order = candidate ? finiteNumber(candidate.order) : undefined;
      if (
        !candidate ||
        order === undefined ||
        !Predicate.isString(candidate.candidate) ||
        (candidate.status !== "eligible" && candidate.status !== "skipped") ||
        !Predicate.isString(candidate.reason)
      )
        return [];
      return [
        (() => {
          const projected: DecodedProfileCandidate = {
            order: Math.max(1, Math.floor(order)),
            candidate: clean(candidate.candidate, 1_024),
            status: candidate.status,
            reason: clean(candidate.reason, 1_024),
          };
          if (candidate.effectiveContext === "fresh" || candidate.effectiveContext === "fork")
            projected.effectiveContext = candidate.effectiveContext;
          return projected;
        })() satisfies SubagentProfileCandidateCard,
      ];
    });
    return [
      (() => {
        const projected: DecodedProfileRoute = {
          id: profile,
          description: clean(record.description, 512),
          source: record.source,
          isDefault: record.isDefault,
          defaultContext: record.defaultContext,
          defaultWriteIntent: record.defaultWriteIntent,
          candidates,
        };
        if (isEffort(record.defaultEffort)) projected.defaultEffort = record.defaultEffort;
        return projected;
      })() satisfies SubagentProfileRouteCard,
    ];
  });
  return profiles.length > 0 ? profiles : undefined;
};

const decodedStartAwaitDetails = new WeakMap<object, SubagentStartAwaitCardDetails | undefined>();

/**
 * Strict current-version renderer boundary for start/await result details.
 * Details objects are immutable, so decodes are memoized per object identity.
 */
export function decodeStartAwaitCardDetails<ValueInput>(
  value: ValueInput,
): SubagentStartAwaitCardDetails | undefined {
  if (!hasObjectRuntimeType(value) || value === null)
    return decodeStartAwaitCardDetailsUncached(value);
  if (decodedStartAwaitDetails.has(value)) return decodedStartAwaitDetails.get(value);
  const decoded = decodeStartAwaitCardDetailsUncached(value);
  decodedStartAwaitDetails.set(value, decoded);
  return decoded;
}

function decodeStartAwaitCardDetailsUncached<ValueInput>(
  value: ValueInput,
): SubagentStartAwaitCardDetails | undefined {
  const record = recordOf(value);
  if (
    !record ||
    record.version !== SUBAGENT_CARD_DETAILS_VERSION ||
    (record.action !== "start" && record.action !== "await") ||
    !Array.isArray(record.cards)
  )
    return undefined;
  const source = record.cards;
  const cards = source.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
    const card = decodeCard(entry);
    return card ? [card] : [];
  });
  if (source.length > 0 && cards.length === 0) return undefined;
  const details: MutableStartAwaitDetails = {
    action: record.action,
    runs: cards,
    startEntries: decodeStartEntries(record.startEntries),
    startFailures: decodeFailures(record.startFailures),
  };
  if (record.awaitUntil === "all_finished" || record.awaitUntil === "any_finished")
    details.awaitUntil = record.awaitUntil;
  if (record.timedOut === true) details.timedOut = true;
  if (record.attentionRequired === true) details.attentionRequired = true;
  if (record.cancelled === true) details.cancelled = true;
  if (record.contentOmitted === true) details.contentOmitted = true;
  return makeStartAwaitCardDetails(details);
}

/** Strict current-version renderer boundary for semantic non-start/await result details. */
export function decodeCompactToolDetails<ValueInput>(
  value: ValueInput,
): CompactSubagentToolDetails | undefined {
  const record = recordOf(value);
  if (
    !record ||
    record.version !== SUBAGENT_CARD_DETAILS_VERSION ||
    !Predicate.isString(record.action) ||
    record.action === "start" ||
    record.action === "await"
  )
    return undefined;
  const source = Array.isArray(record.cards) ? record.cards : [];
  const cards = source.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
    const card = decodeCard(entry);
    return card ? [card] : [];
  });
  const runIds = Array.isArray(record.runIds)
    ? record.runIds
        .slice(0, MAX_TARGET_RUNS)
        .filter((id): id is string => Predicate.isString(id))
        .map((id) => clean(id, 128))
    : undefined;
  const runCount = finiteNumber(record.runCount);
  const profileIds = Array.isArray(record.profileIds)
    ? record.profileIds.slice(0, 16).flatMap((id) => {
        const profile = Predicate.isString(id) ? normalizeProfileId(id) : undefined;
        return profile ? [profile] : [];
      })
    : undefined;
  const profiles = decodeProfiles(record.profiles);
  const actionFailures = Array.isArray(record.actionFailures)
    ? record.actionFailures.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
        const failure = recordOf(entry);
        if (!failure || !Predicate.isString(failure.id) || !Predicate.isString(failure.message))
          return [];
        return [
          (() => {
            const baseResult = { id: clean(failure.id, 128) };
            const withCode = Predicate.isString(failure.code)
              ? { ...baseResult, code: clean(failure.code, 64) }
              : baseResult;
            const withMessage = {
              ...withCode,
              message: clean(failure.message, 256),
            };
            return withMessage;
          })() satisfies CompactToolActionFailure,
        ];
      })
    : undefined;
  return freezeSnapshot(
    (() => {
      const baseResult: CompactSubagentToolDetails = {
        version: SUBAGENT_CARD_DETAILS_VERSION,
        action: clean(record.action, 32),
      };
      const withCards = cards.length > 0 ? { ...baseResult, cards } : baseResult;
      const withRunIds = runIds && runIds.length > 0 ? { ...withCards, runIds } : withCards;
      const withRunCount =
        runCount === undefined
          ? withRunIds
          : { ...withRunIds, runCount: Math.max(0, Math.floor(runCount)) };
      const withProfiles = profiles ? { ...withRunCount, profiles } : withRunCount;
      const withProfileIds =
        profileIds && profileIds.length > 0 ? { ...withProfiles, profileIds } : withProfiles;
      const withFallbackProfile =
        Predicate.isString(record.fallbackProfile) && normalizeProfileId(record.fallbackProfile)
          ? { ...withProfileIds, fallbackProfile: normalizeProfileId(record.fallbackProfile)! }
          : withProfileIds;
      const withActionFailures =
        actionFailures && actionFailures.length > 0
          ? { ...withFallbackProfile, actionFailures }
          : withFallbackProfile;
      const withTimedOut =
        record.timedOut === true ? { ...withActionFailures, timedOut: true } : withActionFailures;
      const withAttentionRequired =
        record.attentionRequired === true
          ? { ...withTimedOut, attentionRequired: true }
          : withTimedOut;
      const withContentOmitted =
        record.contentOmitted === true
          ? { ...withAttentionRequired, contentOmitted: true }
          : withAttentionRequired;
      return withContentOmitted;
    })(),
  );
}
