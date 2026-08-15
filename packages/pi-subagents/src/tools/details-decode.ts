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

const RUN_STATES: ReadonlySet<string> = new Set(SUBAGENT_RUN_STATES);
const EFFORTS: ReadonlySet<string> = new Set(SUBAGENT_EFFORTS);
const CAPABILITIES: ReadonlySet<string> = new Set([
  "steer",
  "interrupt",
  "resume",
  "rename-display",
  "parent-contact",
  "peer-notice",
  "native-fork",
]);
const PROFILE_SOURCES: ReadonlySet<string> = new Set([
  "session",
  "project",
  "project-invalid",
  "global",
  "global-invalid",
  "builtin",
]);
const SOURCES: ReadonlySet<string> = new Set(["profile-candidate", "profile-parent-candidate"]);

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  isJsonObject(value) ? value : undefined;
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const decodeUsage = (value: unknown): SubagentUsage | undefined => {
  const record = recordOf(value);
  if (!record) return undefined;
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
  if (fields.some((field) => finiteNumber(record[field]) === undefined)) return undefined;
  // Cost stays optional: absence means unknown and is preserved rather than becoming $0.
  if (record.cost !== undefined && finiteNumber(record.cost) === undefined) return undefined;
  const cost = finiteNumber(record.cost);
  return boundedUsage({
    input: finiteNumber(record.input) ?? 0,
    output: finiteNumber(record.output) ?? 0,
    cacheRead: finiteNumber(record.cacheRead) ?? 0,
    cacheWrite: finiteNumber(record.cacheWrite) ?? 0,
    totalTokens: finiteNumber(record.totalTokens) ?? 0,
    ...(cost === undefined ? {} : { cost }),
  });
};

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
    ...(typeof record.routeSource === "string" && PROFILE_SOURCES.has(record.routeSource)
      ? { routeSource: record.routeSource as ProfileRouteSource }
      : {}),
    ...(record.host === "local" || record.host === "herdr" ? { host: record.host } : {}),
    ...(record.runtime === "pi" || record.runtime === "claude" || record.runtime === "codex"
      ? { runtime: record.runtime }
      : {}),
    ...(typeof record.closeOnReport === "boolean" ? { closeOnReport: record.closeOnReport } : {}),
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
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter(
        (capability): capability is SubagentCapability =>
          typeof capability === "string" && CAPABILITIES.has(capability),
      )
    : undefined;
  const usage = decodeUsage(record.usage);
  const profile =
    typeof record.profile === "string" ? normalizeProfileId(record.profile) : undefined;
  return {
    id: clean(record.id.trim(), MAX_PROTOCOL_ID_CHARS),
    name: sanitizeName(record.name) || "subagent",
    state: record.state as SubagentRunState,
    ...(profile ? { profile } : {}),
    ...(record.host === "local" || record.host === "herdr" ? { host: record.host } : {}),
    ...(record.runtime === "pi" || record.runtime === "claude" || record.runtime === "codex"
      ? { runtime: record.runtime }
      : {}),
    ...(typeof record.closeOnReport === "boolean" ? { closeOnReport: record.closeOnReport } : {}),
    reportGeneration: Math.max(0, Math.floor(finiteNumber(record.reportGeneration) ?? 0)),
    model: clean(record.model, MAX_CARD_MODEL_CHARS),
    effort: record.effort as SubagentEffort,
    ...(typeof record.fastMode === "boolean" ? { fastMode: record.fastMode } : {}),
    ...(record.context === "fresh" || record.context === "fork" ? { context: record.context } : {}),
    ...(record.writeIntent === "read-only" || record.writeIntent === "writer"
      ? { writeIntent: record.writeIntent }
      : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(finiteNumber(record.startedAt) === undefined
      ? {}
      : { startedAt: boundedNonNegative(finiteNumber(record.startedAt) ?? 0) }),
    ...(finiteNumber(record.lastActivityAt) === undefined
      ? {}
      : { lastActivityAt: boundedNonNegative(finiteNumber(record.lastActivityAt) ?? 0) }),
    ...(usage ? { usage } : {}),
    selection,
    ...(typeof record.currentTool === "string"
      ? { currentTool: clean(record.currentTool, 256) }
      : {}),
    ...(typeof record.progress === "string" ? { progress: clean(record.progress, 512) } : {}),
    ...(typeof record.warning === "string" ? { warning: clean(record.warning, 512) } : {}),
    ...(finiteNumber(record.endedAt) === undefined
      ? {}
      : { endedAt: finiteNumber(record.endedAt) }),
    ...(typeof record.finalText === "string"
      ? { finalText: sanitizeOutputText(record.finalText, MAX_FINAL_TEXT_CHARS) }
      : {}),
    ...(typeof record.error === "string"
      ? { error: sanitizeOutputText(record.error, MAX_ERROR_CHARS) }
      : {}),
    ...(record.finalTextTruncated === true ? { finalTextTruncated: true } : {}),
    ...(record.errorTruncated === true ? { errorTruncated: true } : {}),
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

const decodeStartEntries = (value: unknown): ReadonlyArray<SubagentStartEntry> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
    const record = recordOf(entry);
    const index = record ? finiteNumber(record.index) : undefined;
    if (
      !record ||
      index === undefined ||
      typeof record.name !== "string" ||
      (record.status !== "pending" && record.status !== "started" && record.status !== "failed")
    )
      return [];
    const selected =
      record.routeStatus === "selected" &&
      (record.host === "local" || record.host === "herdr") &&
      (record.runtime === "pi" || record.runtime === "claude" || record.runtime === "codex") &&
      typeof record.model === "string" &&
      clean(record.model, MAX_CARD_MODEL_CHARS).length > 0 &&
      typeof record.effort === "string" &&
      EFFORTS.has(record.effort);
    const routeStatus =
      record.status === "pending" ? "resolving" : selected ? "selected" : "unavailable";
    const candidateIndex = finiteNumber(record.candidateIndex);
    return [
      {
        index: Math.max(0, Math.floor(index)),
        name: clean(record.name, MAX_NAME_CHARS),
        profile:
          (typeof record.profile === "string" ? clean(record.profile, 64) : "") || "generalist",
        status: record.status,
        routeStatus,
        ...(selected
          ? {
              host: record.host as SubagentHost,
              runtime: record.runtime as SubagentRuntime,
              model: clean(record.model as string, MAX_CARD_MODEL_CHARS),
              effort: record.effort as SubagentEffort,
              ...(record.fastMode === true ? { fastMode: true } : {}),
              ...(candidateIndex === undefined
                ? {}
                : { candidateIndex: Math.max(0, Math.floor(candidateIndex)) }),
            }
          : {}),
        ...(typeof record.runId === "string"
          ? { runId: clean(record.runId, MAX_PROTOCOL_ID_CHARS) }
          : {}),
      } satisfies SubagentStartEntry,
    ];
  });
  return entries.length > 0 ? entries : undefined;
};

const decodeProfiles = (value: unknown): ReadonlyArray<SubagentProfileRouteCard> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const profiles = value.slice(0, 16).flatMap((entry) => {
    const record = recordOf(entry);
    const profile =
      record && typeof record.id === "string" ? normalizeProfileId(record.id) : undefined;
    if (
      !record ||
      !profile ||
      typeof record.description !== "string" ||
      typeof record.source !== "string" ||
      !PROFILE_SOURCES.has(record.source) ||
      typeof record.isDefault !== "boolean" ||
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
        typeof candidate.candidate !== "string" ||
        (candidate.status !== "eligible" && candidate.status !== "skipped") ||
        typeof candidate.reason !== "string"
      )
        return [];
      return [
        {
          order: Math.max(1, Math.floor(order)),
          candidate: clean(candidate.candidate, 1_024),
          status: candidate.status,
          ...(candidate.effectiveContext === "fresh" || candidate.effectiveContext === "fork"
            ? { effectiveContext: candidate.effectiveContext }
            : {}),
          reason: clean(candidate.reason, 1_024),
        } satisfies SubagentProfileCandidateCard,
      ];
    });
    return [
      {
        id: profile,
        description: clean(record.description, 512),
        source: record.source as ProfileRouteSource,
        isDefault: record.isDefault,
        defaultContext: record.defaultContext,
        defaultWriteIntent: record.defaultWriteIntent,
        ...(typeof record.defaultEffort === "string" && EFFORTS.has(record.defaultEffort)
          ? { defaultEffort: record.defaultEffort as SubagentEffort }
          : {}),
        candidates,
      } satisfies SubagentProfileRouteCard,
    ];
  });
  return profiles.length > 0 ? profiles : undefined;
};

const decodedStartAwaitDetails = new WeakMap<object, SubagentStartAwaitCardDetails | undefined>();

/**
 * Strict current-version renderer boundary for start/await result details.
 * Details objects are immutable, so decodes are memoized per object identity.
 */
export function decodeStartAwaitCardDetails(
  value: unknown,
): SubagentStartAwaitCardDetails | undefined {
  if (typeof value !== "object" || value === null)
    return decodeStartAwaitCardDetailsUncached(value);
  if (decodedStartAwaitDetails.has(value)) return decodedStartAwaitDetails.get(value);
  const decoded = decodeStartAwaitCardDetailsUncached(value);
  decodedStartAwaitDetails.set(value, decoded);
  return decoded;
}

function decodeStartAwaitCardDetailsUncached(
  value: unknown,
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
  return makeStartAwaitCardDetails({
    action: record.action,
    runs: cards,
    startEntries: decodeStartEntries(record.startEntries),
    startFailures: decodeFailures(record.startFailures),
    ...(record.awaitUntil === "all_finished" || record.awaitUntil === "any_finished"
      ? { awaitUntil: record.awaitUntil }
      : {}),
    ...(record.timedOut === true ? { timedOut: true } : {}),
    ...(record.attentionRequired === true ? { attentionRequired: true } : {}),
    ...(record.cancelled === true ? { cancelled: true } : {}),
    ...(record.contentOmitted === true ? { contentOmitted: true } : {}),
  });
}

/** Strict current-version renderer boundary for semantic non-start/await result details. */
export function decodeCompactToolDetails(value: unknown): CompactSubagentToolDetails | undefined {
  const record = recordOf(value);
  if (
    !record ||
    record.version !== SUBAGENT_CARD_DETAILS_VERSION ||
    typeof record.action !== "string" ||
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
        .filter((id): id is string => typeof id === "string")
        .map((id) => clean(id, 128))
    : undefined;
  const runCount = finiteNumber(record.runCount);
  const profileIds = Array.isArray(record.profileIds)
    ? record.profileIds.slice(0, 16).flatMap((id) => {
        const profile = typeof id === "string" ? normalizeProfileId(id) : undefined;
        return profile ? [profile] : [];
      })
    : undefined;
  const profiles = decodeProfiles(record.profiles);
  const actionFailures = Array.isArray(record.actionFailures)
    ? record.actionFailures.slice(0, MAX_TARGET_RUNS).flatMap((entry) => {
        const failure = recordOf(entry);
        if (!failure || typeof failure.id !== "string" || typeof failure.message !== "string")
          return [];
        return [
          {
            id: clean(failure.id, 128),
            ...(typeof failure.code === "string" ? { code: clean(failure.code, 64) } : {}),
            message: clean(failure.message, 256),
          } satisfies CompactToolActionFailure,
        ];
      })
    : undefined;
  return freezeSnapshot({
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: clean(record.action, 32),
    ...(cards.length > 0 ? { cards } : {}),
    ...(runIds && runIds.length > 0 ? { runIds } : {}),
    ...(runCount === undefined ? {} : { runCount: Math.max(0, Math.floor(runCount)) }),
    ...(profiles ? { profiles } : {}),
    ...(profileIds && profileIds.length > 0 ? { profileIds } : {}),
    ...(typeof record.fallbackProfile === "string" && normalizeProfileId(record.fallbackProfile)
      ? { fallbackProfile: normalizeProfileId(record.fallbackProfile)! }
      : {}),
    ...(actionFailures && actionFailures.length > 0 ? { actionFailures } : {}),
    ...(record.timedOut === true ? { timedOut: true } : {}),
    ...(record.attentionRequired === true ? { attentionRequired: true } : {}),
    ...(record.contentOmitted === true ? { contentOmitted: true } : {}),
  });
}
