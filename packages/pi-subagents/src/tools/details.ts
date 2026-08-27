import { stripTerminalControls } from "pi-cosmic-core";
import {
  SUBAGENT_EFFORTS,
  type SubagentContextMode,
  type SubagentEffort,
  type SubagentWriteIntent,
} from "../domain/routing.ts";
import {
  MAX_PROFILE_CANDIDATES,
  MAX_PROFILE_MODEL_SELECTOR_CHARS,
  PROFILE_IDS,
  type ProfileCandidate,
  type ProfileId,
  type ProfileRouteSource,
} from "../profiles/model.ts";
import type { SubagentRunView, SubagentUsage } from "../run/model.ts";
import { MAX_WRITE_CLAIMS, MAX_WRITE_CLAIM_CHARS } from "../domain/write-claims.ts";
import { MAX_PROTOCOL_ID_CHARS, MAX_TARGET_RUNS } from "../run/limits.ts";
import { projectRunCardTree } from "./run-card-tree.ts";
import {
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  MAX_NAME_CHARS,
  safeTextPrefix,
  sanitizeName,
} from "../run/state.ts";
import {
  MAX_CARD_MODEL_CHARS,
  MAX_CARD_PROVENANCE_CHARS,
  MAX_CARD_QUESTION_CHARS,
  MAX_CARD_SKIPS,
  SUBAGENT_CARD_DETAILS_VERSION,
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type CompactSubagentToolDetails,
  type CompactToolActionFailure,
  type SubagentAwaitDetails,
  type SubagentCardFailure,
  type SubagentProfileCandidateCard,
  type SubagentProfileRouteCard,
  type SubagentRunCard,
  type SubagentStartAwaitCardDetails,
  type SubagentStartDetails,
  type SubagentStartEntry,
} from "./details-schema.ts";

export {
  MAX_CARD_MODEL_CHARS,
  MAX_CARD_PROVENANCE_CHARS,
  MAX_CARD_QUESTION_CHARS,
  MAX_CARD_SKIPS,
  SUBAGENT_CARD_DETAILS_VERSION,
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
};
export type {
  CompactSubagentToolDetails,
  CompactToolActionFailure,
  SubagentAwaitDetails,
  SubagentCardFailure,
  SubagentProfileCandidateCard,
  SubagentProfileRouteCard,
  SubagentRunCard,
  SubagentStartAwaitCardDetails,
  SubagentStartDetails,
  SubagentStartEntry,
};

const MAX_PROFILE_CHARS = 64;
const MAX_ACTION_FAILURE_ID_CHARS = 128;
const MAX_ACTION_FAILURE_CODE_CHARS = 64;
const MAX_ACTION_FAILURE_MESSAGE_CHARS = 256;
const MAX_FAILURE_CODE_CHARS = 128;
const MAX_FAILURE_MESSAGE_CHARS = 512;

type DetailDensity = "full" | "compact" | "minimal";
type RunDetailsAction =
  | "list"
  | "status"
  | "send"
  | "reply"
  | "retry"
  | "interrupt"
  | "resume"
  | "stop"
  | "rename"
  | "claims";

export interface StartDetailsInput {
  readonly startEntries: ReadonlyArray<SubagentStartEntry>;
  readonly startFailures?: ReadonlyArray<SubagentCardFailure> | undefined;
}

export interface AwaitDetailsInput {
  /** Runs whose state controls completion and whose reports may be claimed by this await. */
  readonly runs: ReadonlyArray<SubagentRunView>;
  /** Read-only descendant context; reports are always omitted from these cards. */
  readonly contextRuns?: ReadonlyArray<SubagentRunView> | undefined;
  /** Original targets retained when cancellation occurs before the first observation. */
  readonly awaitedRunIds?: ReadonlyArray<string> | undefined;
  readonly awaitUntil: "all_finished" | "any_finished";
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  readonly contentOmitted?: boolean | undefined;
}

export interface ProfileCandidateDetailsInput extends ProfileCandidate {
  readonly status: "eligible" | "skipped";
  readonly reason: string;
}

export interface ProfileRouteDetailsInput {
  readonly id: ProfileId;
  readonly description: string;
  readonly source: ProfileRouteSource;
  readonly isDefault: boolean;
  readonly defaultContext: SubagentContextMode;
  readonly defaultWriteIntent: SubagentWriteIntent;
  readonly defaultEffort?: SubagentEffort | undefined;
  readonly candidates: ReadonlyArray<ProfileCandidateDetailsInput>;
}

export type CompactToolDetailsInput =
  | {
      readonly action: "models";
      readonly profiles: ReadonlyArray<ProfileRouteDetailsInput>;
      readonly fallbackProfile: ProfileId;
    }
  | {
      readonly action: RunDetailsAction;
      readonly runs: ReadonlyArray<SubagentRunView>;
      readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
    };

interface StringLimits {
  readonly id: number;
  readonly name: number;
  readonly model: number;
  readonly provenance: number;
  readonly skipped: number;
  readonly currentTool: number;
  readonly progress: number;
  readonly warning: number;
  readonly question: number;
}

const STRING_LIMITS = {
  full: {
    id: MAX_PROTOCOL_ID_CHARS,
    name: MAX_NAME_CHARS,
    model: MAX_CARD_MODEL_CHARS,
    provenance: MAX_CARD_PROVENANCE_CHARS,
    skipped: MAX_CARD_SKIPS,
    currentTool: 256,
    progress: 512,
    warning: 512,
    question: MAX_CARD_QUESTION_CHARS,
  },
  compact: {
    id: 256,
    name: MAX_NAME_CHARS,
    model: MAX_CARD_MODEL_CHARS,
    provenance: 256,
    skipped: 4,
    currentTool: 128,
    progress: 256,
    warning: 256,
    question: 1_024,
  },
  minimal: {
    id: 128,
    name: 64,
    model: MAX_CARD_MODEL_CHARS,
    provenance: 96,
    skipped: 0,
    currentTool: 64,
    progress: 96,
    warning: 96,
    question: 512,
  },
} as const satisfies Readonly<Record<DetailDensity, StringLimits>>;

const clean = (value: string, maximum: number): string =>
  safeTextPrefix(stripTerminalControls(value).replaceAll("\u0000", ""), maximum);
const requiredText = (value: string, maximum: number, fallback: string): string =>
  clean(value, maximum).trim() || fallback;
const optionalText = (value: string | undefined, maximum: number): string | undefined => {
  if (value === undefined) return undefined;
  const projected = clean(value, maximum);
  return projected.length > 0 ? projected : undefined;
};
const nonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value)) : 0;
const nonNegativeInteger = (value: number): number => Math.floor(nonNegative(value));

const projectUsage = (usage: SubagentUsage): SubagentRunCard["usage"] => {
  const base = {
    input: nonNegative(usage.input),
    output: nonNegative(usage.output),
    cacheRead: nonNegative(usage.cacheRead),
    cacheWrite: nonNegative(usage.cacheWrite),
    totalTokens: nonNegative(usage.totalTokens),
  };
  return usage.cost === undefined ? base : { ...base, cost: nonNegative(usage.cost) };
};

const projectSelection = (
  selection: SubagentRunView["selection"],
  density: DetailDensity,
): SubagentRunCard["selection"] => {
  const limits = STRING_LIMITS[density];
  const base = {
    source: selection.source,
    reason: requiredText(
      selection.reason,
      limits.provenance,
      "Route selection detail unavailable.",
    ),
    skippedCandidates: selection.skippedCandidates.slice(0, limits.skipped).map((candidate) => ({
      candidate: requiredText(candidate.candidate, limits.provenance, "unknown candidate"),
      code: requiredText(candidate.code, MAX_FAILURE_CODE_CHARS, "unavailable"),
      reason: requiredText(candidate.reason, limits.provenance, "Unavailable."),
    })),
  };
  const withCandidate =
    selection.candidateIndex === undefined
      ? base
      : { ...base, candidateIndex: nonNegativeInteger(selection.candidateIndex) };
  const warning = optionalText(selection.warning, limits.provenance);
  return warning === undefined ? withCandidate : { ...withCandidate, warning };
};

const projectWriteCardFields = (
  run: SubagentRunView,
  density: DetailDensity,
): Partial<SubagentRunCard> => {
  const base = {};
  const claimLimit = density === "full" ? MAX_WRITE_CLAIMS : density === "compact" ? 16 : 4;
  const projectedClaims = run.writeClaims
    ? run.writeClaims
        .slice(0, claimLimit)
        .map((path) => requiredText(path, MAX_WRITE_CLAIM_CHARS, "unknown-file"))
    : undefined;
  const withClaims = projectedClaims
    ? {
        ...base,
        writeClaims: projectedClaims,
        writeClaimCount: nonNegativeInteger(run.writeClaims?.length ?? 0),
      }
    : base;
  const withClaimOmission =
    run.writeClaims && run.writeClaims.length > claimLimit
      ? { ...withClaims, writeClaimsOmitted: true as const }
      : withClaims;
  const observedLimit = density === "full" ? 64 : density === "compact" ? 16 : 0;
  const violationLimit = density === "full" ? 16 : density === "compact" ? 8 : 0;
  const withAudit = run.writeAudit
    ? {
        ...withClaimOmission,
        writeAudit: {
          observedFileWrites: (observedLimit === 0
            ? []
            : run.writeAudit.observedFileWrites.slice(-observedLimit)
          ).map((path) => requiredText(path, MAX_WRITE_CLAIM_CHARS, "unknown-file")),
          violations: (violationLimit === 0
            ? []
            : run.writeAudit.violations.slice(-violationLimit)
          ).map((violation) => ({
            path: requiredText(violation.path, MAX_WRITE_CLAIM_CHARS, "unknown-file"),
            toolName: requiredText(violation.toolName, 200, "unknown-tool"),
            observedAt: nonNegative(violation.observedAt),
          })),
          bashWriteHints: nonNegativeInteger(run.writeAudit.bashWriteHints),
        },
      }
    : withClaimOmission;
  return run.writeAdmissionPaused === true
    ? { ...withAudit, writeAdmissionPaused: true as const }
    : withAudit;
};

const projectOptionalCardFields = (
  run: SubagentRunView,
  density: DetailDensity,
): Partial<SubagentRunCard> => {
  const limits = STRING_LIMITS[density];
  const currentTool = optionalText(run.currentTool, limits.currentTool);
  const progress = optionalText(run.progress, limits.progress);
  const warning = optionalText(run.warning, limits.warning);
  const endedAt = run.endedAt === undefined ? undefined : nonNegative(run.endedAt);
  const question = optionalText(run.question?.message, limits.question);
  const base = {};
  const withCurrentTool = currentTool === undefined ? base : { ...base, currentTool };
  const withProgress = progress === undefined ? withCurrentTool : { ...withCurrentTool, progress };
  const withWarning = warning === undefined ? withProgress : { ...withProgress, warning };
  const withEndedAt = endedAt === undefined ? withWarning : { ...withWarning, endedAt };
  return question === undefined ? withEndedAt : { ...withEndedAt, question: { message: question } };
};

/** Explicit privacy projection from a run view to persisted renderer fields. */
export const projectSubagentRunCard = (
  run: SubagentRunView,
  density: DetailDensity = "full",
): SubagentRunCard => {
  const limits = STRING_LIMITS[density];
  const profile = run.profile && PROFILE_IDS.includes(run.profile) ? run.profile : undefined;
  const base = {
    id: requiredText(run.id, limits.id, "unknown-run"),
    name: sanitizeName(run.name) || "subagent",
    state: run.state,
    host: run.host,
    runtime: run.runtime,
    closeOnReport: run.closeOnReport,
    reportGeneration: nonNegativeInteger(run.reportGeneration),
    model: requiredText(run.model, limits.model, "unknown-model"),
    effort: SUBAGENT_EFFORTS.includes(run.effort) ? run.effort : ("off" as const),
    fastMode: run.fastMode,
    context: run.context,
    writeIntent: run.writeIntent,
    capabilities: [...run.capabilities],
    startedAt: nonNegative(run.startedAt),
    lastActivityAt: nonNegative(run.lastActivityAt),
    usage: projectUsage(run.usage),
    selection: projectSelection(run.selection, density),
    ...projectWriteCardFields(run, density),
    ...projectOptionalCardFields(run, density),
  };
  const parentRunId = optionalText(run.parentRunId, limits.id);
  const withParent =
    parentRunId === undefined
      ? base
      : {
          ...base,
          parentRunId,
          depth: nonNegativeInteger(run.depth ?? 1),
          directChildCount: nonNegativeInteger(run.directChildCount ?? 0),
          descendantCount: nonNegativeInteger(run.descendantCount ?? 0),
        };
  const nativeLatestId = optionalText(run.nativeActivity?.latest?.id, 256);
  let nativeActivity: SubagentRunCard["nativeActivity"];
  if (run.nativeActivity) {
    nativeActivity = {
      active: nonNegativeInteger(run.nativeActivity.active),
      total: nonNegativeInteger(run.nativeActivity.total),
    };
    if (run.nativeActivity.latest) {
      const latestBase = {
        kind: requiredText(run.nativeActivity.latest.kind, 128, "native-agent"),
        state: run.nativeActivity.latest.state,
        updatedAt: nonNegative(run.nativeActivity.latest.updatedAt),
      };
      nativeActivity = {
        ...nativeActivity,
        latest: nativeLatestId ? { ...latestBase, id: nativeLatestId } : latestBase,
      };
    }
  }
  const withNative = nativeActivity ? { ...withParent, nativeActivity } : withParent;
  const withProfile = profile === undefined ? withNative : { ...withNative, profile };
  const finalText = optionalText(run.finalText, MAX_FINAL_TEXT_CHARS);
  const error = optionalText(run.error, MAX_ERROR_CHARS);
  const withFinal = finalText === undefined ? withProfile : { ...withProfile, finalText };
  const withError = error === undefined ? withFinal : { ...withFinal, error };
  const withFinalFlag =
    run.finalText !== undefined && finalText?.length !== stripTerminalControls(run.finalText).length
      ? { ...withError, finalTextTruncated: true as const }
      : withError;
  return run.error !== undefined && error?.length !== stripTerminalControls(run.error).length
    ? { ...withFinalFlag, errorTruncated: true as const }
    : withFinalFlag;
};

const omitReports = (card: SubagentRunCard): SubagentRunCard => {
  const { finalText, error, ...summary } = card;
  const withFinalFlag =
    finalText === undefined ? summary : { ...summary, finalTextTruncated: true as const };
  return error === undefined ? withFinalFlag : { ...withFinalFlag, errorTruncated: true as const };
};

const projectFailure = (
  failure: SubagentCardFailure,
  density: DetailDensity,
): SubagentCardFailure => {
  const maximumMessage =
    density === "full" ? MAX_FAILURE_MESSAGE_CHARS : density === "compact" ? 256 : 96;
  const maximumCode = density === "full" ? MAX_FAILURE_CODE_CHARS : density === "compact" ? 64 : 48;
  const name = optionalText(failure.name, density === "minimal" ? 48 : MAX_NAME_CHARS);
  const code = optionalText(failure.code, maximumCode);
  const base = { index: nonNegativeInteger(failure.index) };
  const withName = name === undefined ? base : { ...base, name };
  const withMessage = {
    ...withName,
    message: requiredText(failure.message, maximumMessage, "Launch failed."),
  };
  const withCode = code === undefined ? withMessage : { ...withMessage, code };
  if (!failure.admittedRun) return withCode;
  const recovery = failure.admittedRun;
  return {
    ...withCode,
    admittedRun: {
      runId: requiredText(
        recovery.runId,
        density === "full" ? MAX_PROTOCOL_ID_CHARS : density === "compact" ? 256 : 128,
        "unknown-run",
      ),
      cleanupDisposition: recovery.cleanupDisposition,
      retryDisposition: recovery.retryDisposition,
      remainingCandidateCount: nonNegativeInteger(recovery.remainingCandidateCount),
      hasRemainingCandidate: recovery.hasRemainingCandidate,
    },
  };
};

const projectStartEntry = (
  entry: SubagentStartEntry,
  density: DetailDensity,
): SubagentStartEntry => {
  const identity = {
    index: nonNegativeInteger(entry.index),
    name: requiredText(entry.name, density === "minimal" ? 48 : MAX_NAME_CHARS, "launch"),
    profile: requiredText(
      entry.profile,
      density === "full" ? MAX_PROFILE_CHARS : density === "compact" ? 48 : 32,
      "generalist",
    ),
  };
  if (entry.status === "pending")
    return { ...identity, status: "pending", routeStatus: "resolving" };
  if (entry.routeStatus === "unavailable")
    return { ...identity, status: "failed", routeStatus: "unavailable" };
  const selectedBase = {
    ...identity,
    status: entry.status,
    routeStatus: "selected" as const,
    host: entry.host,
    runtime: entry.runtime,
    model: requiredText(entry.model, MAX_CARD_MODEL_CHARS, "unknown-model"),
    effort: entry.effort,
    fastMode: entry.fastMode,
  };
  const selected =
    entry.candidateIndex === undefined
      ? selectedBase
      : { ...selectedBase, candidateIndex: nonNegativeInteger(entry.candidateIndex) };
  const warning = optionalText(
    entry.warning,
    density === "full" ? MAX_CARD_PROVENANCE_CHARS : density === "compact" ? 512 : 160,
  );
  const withWarning = warning === undefined ? selected : { ...selected, warning };
  return entry.status === "started"
    ? {
        ...withWarning,
        status: "started",
        runId: requiredText(
          entry.runId,
          density === "full" ? MAX_PROTOCOL_ID_CHARS : density === "compact" ? 256 : 128,
          "unknown-run",
        ),
      }
    : { ...withWarning, status: "failed" };
};

/** Explicit privacy projection for request-ordered start receipts. */
export const projectSubagentStartEntries = (
  entries: ReadonlyArray<SubagentStartEntry>,
  density: DetailDensity = "full",
): ReadonlyArray<SubagentStartEntry> =>
  entries.slice(0, MAX_TARGET_RUNS).map((entry) => projectStartEntry(entry, density));

const profileLimits = (density: DetailDensity) =>
  density === "full"
    ? { description: 512, model: MAX_PROFILE_MODEL_SELECTOR_CHARS, reason: 1_024 }
    : density === "compact"
      ? { description: 256, model: MAX_PROFILE_MODEL_SELECTOR_CHARS, reason: 256 }
      : { description: 48, model: 24, reason: 24 };
const boundedAsciiOr = (value: string, maximum: number, fallback: string): string => {
  const cleaned = stripTerminalControls(value).trim();
  return cleaned.length > 0 && cleaned.length <= maximum && /^[\x20-\x7e]+$/.test(cleaned)
    ? cleaned
    : fallback;
};

/** Explicit privacy projection for persisted profile-route discovery. */
export const projectSubagentProfileRoutes = (
  profiles: ReadonlyArray<ProfileRouteDetailsInput>,
  density: DetailDensity = "full",
): ReadonlyArray<SubagentProfileRouteCard> => {
  const limits = profileLimits(density);
  return profiles.slice(0, PROFILE_IDS.length).map((profile) => {
    const base = {
      id: profile.id,
      description: requiredText(profile.description, limits.description, "Profile route."),
      source: profile.source,
      isDefault: profile.isDefault,
      defaultContext: profile.defaultContext,
      defaultWriteIntent: profile.defaultWriteIntent,
      candidates: profile.candidates.slice(0, MAX_PROFILE_CANDIDATES).map((candidate) => ({
        host: candidate.host,
        runtime: candidate.runtime,
        model:
          density === "minimal"
            ? boundedAsciiOr(
                candidate.model,
                limits.model,
                candidate.runtime === "pi" ? "x/y" : "x",
              )
            : requiredText(candidate.model, limits.model, "omitted-model"),
        effort: candidate.effort,
        context: candidate.context,
        writeIntent: candidate.writeIntent,
        fastMode: candidate.fastMode,
        closeOnReport: candidate.closeOnReport,
        status: candidate.status,
        reason:
          density === "minimal"
            ? boundedAsciiOr(candidate.reason, limits.reason, "Omitted.")
            : requiredText(candidate.reason, limits.reason, "Route detail omitted."),
      })),
    };
    return profile.defaultEffort === undefined
      ? base
      : { ...base, defaultEffort: profile.defaultEffort };
  });
};

const projectActionFailures = (
  failures: ReadonlyArray<CompactToolActionFailure> | undefined,
  density: DetailDensity,
): ReadonlyArray<CompactToolActionFailure> | undefined => {
  if (!failures || failures.length === 0) return undefined;
  const messageLimit =
    density === "full" ? MAX_ACTION_FAILURE_MESSAGE_CHARS : density === "compact" ? 160 : 96;
  const idLimit = density === "minimal" ? 64 : MAX_ACTION_FAILURE_ID_CHARS;
  return failures.slice(0, MAX_TARGET_RUNS).map((failure) => {
    const code = optionalText(failure.code, MAX_ACTION_FAILURE_CODE_CHARS);
    const base = { id: requiredText(failure.id, idLimit, "unknown-run") };
    const withCode = code === undefined ? base : { ...base, code };
    return {
      ...withCode,
      message: requiredText(failure.message, messageLimit, "Action failed."),
    };
  });
};

const semanticCandidate = <Candidate, Details>(
  candidates: ReadonlyArray<Candidate>,
  decode: (candidate: Candidate) => Details | undefined,
): Details => {
  for (const candidate of candidates) {
    const decoded = decode(candidate);
    if (decoded !== undefined) return decoded;
  }
  throw new Error("Unable to construct bounded persisted subagent details.");
};

const startDetailsCandidate = (
  input: StartDetailsInput,
  density: DetailDensity,
): SubagentStartDetails => {
  const base: SubagentStartDetails = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "start",
    startEntries: projectSubagentStartEntries(input.startEntries, density),
  };
  const failures = input.startFailures
    ? [...input.startFailures]
        .sort((left, right) => left.index - right.index)
        .map((failure) => projectFailure(failure, density))
    : undefined;
  return failures && failures.length > 0 ? { ...base, startFailures: failures } : base;
};

/** Makes strict version-2 start details. Start details never persist run cards. */
export const makeStartDetails = (input: StartDetailsInput): SubagentStartDetails =>
  semanticCandidate(
    [
      startDetailsCandidate(input, "full"),
      startDetailsCandidate(input, "compact"),
      startDetailsCandidate(input, "minimal"),
    ],
    (value) => {
      const decoded = decodeStartAwaitCardDetails(value);
      return decoded?.action === "start" ? decoded : undefined;
    },
  );

const reportsWereOmitted = (runs: ReadonlyArray<SubagentRunView>): boolean =>
  runs.some((run) => run.finalText !== undefined || run.error !== undefined);

const awaitCandidate = (
  input: AwaitDetailsInput,
  density: DetailDensity,
  includeReports: boolean,
): SubagentAwaitDetails => {
  const source = input.runs.slice(0, MAX_TARGET_RUNS);
  const requestedAwaitedRunIds = (input.awaitedRunIds ?? source.map((run) => run.id)).slice(
    0,
    MAX_TARGET_RUNS,
  );
  const targetIds = new Set(source.map((run) => run.id));
  const contextCandidates = projectRunCardTree(input.contextRuns ?? [])
    .map((row) => row.run)
    .filter((run) => !targetIds.has(run.id));
  const contextSource = contextCandidates.slice(0, Math.max(0, MAX_TARGET_RUNS - source.length));
  const targetCards = source.map((run) => {
    const card = projectSubagentRunCard(run, density);
    return includeReports ? card : omitReports(card);
  });
  const contextCards = contextSource.map((run) =>
    omitReports(projectSubagentRunCard(run, density)),
  );
  const awaitedRunIds =
    targetCards.length > 0 ? targetCards.map((card) => card.id) : requestedAwaitedRunIds;
  const base: SubagentAwaitDetails = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "await",
    cards: [...targetCards, ...contextCards],
    awaitedRunIds,
    awaitUntil: input.awaitUntil,
  };
  const withTimedOut = input.timedOut ? { ...base, timedOut: true as const } : base;
  const withAttention = input.attentionRequired
    ? { ...withTimedOut, attentionRequired: true as const }
    : withTimedOut;
  const withCancelled = input.cancelled
    ? { ...withAttention, cancelled: true as const }
    : withAttention;
  const withContextOmission =
    contextCandidates.length > contextSource.length
      ? { ...withCancelled, contextOmitted: true as const }
      : withCancelled;
  const omitted = !includeReports && reportsWereOmitted(source);
  return input.contentOmitted || omitted
    ? { ...withContextOmission, contentOmitted: true as const }
    : withContextOmission;
};

/** Makes strict version-2 await details with semantic fitting stages. */
export const makeAwaitDetails = (input: AwaitDetailsInput): SubagentAwaitDetails =>
  semanticCandidate(
    [
      awaitCandidate(input, "full", true),
      awaitCandidate(input, "full", false),
      awaitCandidate(input, "compact", false),
      awaitCandidate(input, "minimal", false),
    ],
    (value) => {
      const decoded = decodeStartAwaitCardDetails(value);
      return decoded?.action === "await" ? decoded : undefined;
    },
  );

interface RunDetailsCandidate {
  readonly version: typeof SUBAGENT_CARD_DETAILS_VERSION;
  readonly action: RunDetailsAction;
  readonly cards: ReadonlyArray<SubagentRunCard>;
  readonly runCount: number;
  readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
  readonly contentOmitted?: true | undefined;
}

const runDetailsCandidate = (
  input: Extract<CompactToolDetailsInput, { readonly action: RunDetailsAction }>,
  density: DetailDensity,
  includeReports: boolean,
): RunDetailsCandidate => {
  const orderedRuns =
    input.action === "list" ? projectRunCardTree(input.runs).map((row) => row.run) : input.runs;
  const source = orderedRuns.slice(0, MAX_TARGET_RUNS);
  const cards = source.map((run) => {
    const card = projectSubagentRunCard(run, density);
    return includeReports ? card : omitReports(card);
  });
  const base: RunDetailsCandidate = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: input.action,
    cards,
    runCount: input.runs.length,
  };
  const failures = projectActionFailures(input.actionFailures, density);
  const withFailures =
    failures && failures.length > 0 ? { ...base, actionFailures: failures } : base;
  const omitted = !includeReports && reportsWereOmitted(source);
  return omitted ? { ...withFailures, contentOmitted: true as const } : withFailures;
};

const modelDetailsCandidate = (
  input: Extract<CompactToolDetailsInput, { readonly action: "models" }>,
  density: DetailDensity,
): Extract<CompactSubagentToolDetails, { readonly action: "models" }> => {
  const base: Extract<CompactSubagentToolDetails, { readonly action: "models" }> = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "models",
    profiles: projectSubagentProfileRoutes(input.profiles, density),
    fallbackProfile: input.fallbackProfile,
  };
  return density === "full" ? base : { ...base, contentOmitted: true as const };
};

/** Makes strict version-2 details for every non-start/await action. */
export const makeCompactToolDetails = (
  input: CompactToolDetailsInput,
): CompactSubagentToolDetails => {
  if (input.action === "models")
    return semanticCandidate(
      [
        modelDetailsCandidate(input, "full"),
        modelDetailsCandidate(input, "compact"),
        modelDetailsCandidate(input, "minimal"),
      ],
      decodeCompactToolDetails,
    );
  const withReports = input.action === "status";
  return semanticCandidate(
    [
      runDetailsCandidate(input, "full", withReports),
      runDetailsCandidate(input, "full", false),
      runDetailsCandidate(input, "compact", false),
      runDetailsCandidate(input, "minimal", false),
    ],
    decodeCompactToolDetails,
  );
};
