import { safeTextPrefix, stripTerminalControls } from "pi-cosmic-core";
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import {
  MAX_PROFILE_CANDIDATES,
  MAX_PROFILE_MODEL_SELECTOR_CHARS,
  PROFILE_IDS,
  type ProfileId,
} from "../profiles/model.ts";
import type { SubagentRunView, SubagentUsage } from "../run/model.ts";
import { MAX_WRITE_CLAIMS, MAX_WRITE_CLAIM_CHARS } from "../domain/write-claims.ts";
import { MAX_PROTOCOL_ID_CHARS, MAX_START_BATCH, MAX_TARGET_RUNS } from "../run/limits.ts";
import { MAX_OBSERVED_WRITE_PATHS, MAX_WRITE_CLAIM_VIOLATIONS } from "../run/claims-observation.ts";
import { projectRunCardTree } from "../ui/run-tree-rows.ts";
import {
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  MAX_NAME_CHARS,
  boundedAsciiOr,
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
  MAX_ACTION_FAILURE_CODE_CHARS,
  MAX_ACTION_FAILURE_ID_CHARS,
  MAX_ACTION_FAILURE_MESSAGE_CHARS,
  MAX_CURRENT_TOOL_CHARS,
  MAX_FAILURE_CODE_CHARS,
  MAX_FAILURE_MESSAGE_CHARS,
  MAX_PROFILE_CANDIDATE_REASON_CHARS,
  MAX_PROFILE_CHARS,
  MAX_PROFILE_DESCRIPTION_CHARS,
  MAX_PROGRESS_CHARS,
  MAX_WARNING_CHARS,
  type CompactSubagentToolDetails,
  type CompactToolActionFailure,
  type RunDetailsAction,
  type SubagentAwaitDetails,
  type SubagentCardFailure,
  type SubagentProfileRouteCard,
  type SubagentRunCard,
  type SubagentStartDetails,
  type SubagentStartEntry,
} from "./details-schema.ts";
import type { SubagentProfileView } from "./model.ts";
import { actionFailureDisposition } from "./outcome.ts";

type DetailDensity = "full" | "compact" | "minimal";

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
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  readonly cancellationCleanup?: "unconfirmed" | undefined;
}

export type CompactToolDetailsInput =
  | {
      readonly action: "models";
      readonly profiles: ReadonlyArray<SubagentProfileView>;
      readonly fallbackProfile: ProfileId;
    }
  | {
      readonly action: RunDetailsAction;
      readonly runs: ReadonlyArray<SubagentRunView>;
      readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
    };

/** Per-density caps for projected field families: full owns the base caps; compact tightens full, minimal tightens compact.
 * Shared caps are inherited rather than duplicated; caps equal at every density use one key or constant. */
const FULL_LIMITS = {
  id: MAX_PROTOCOL_ID_CHARS,
  provenance: MAX_CARD_PROVENANCE_CHARS,
  skipped: MAX_CARD_SKIPS,
  currentTool: MAX_CURRENT_TOOL_CHARS,
  progress: MAX_PROGRESS_CHARS,
  warning: MAX_WARNING_CHARS,
  question: MAX_CARD_QUESTION_CHARS,
  writeClaims: MAX_WRITE_CLAIMS,
  observedWrites: MAX_OBSERVED_WRITE_PATHS,
  writeViolations: MAX_WRITE_CLAIM_VIOLATIONS,
  shortName: MAX_NAME_CHARS,
  startProfile: MAX_PROFILE_CHARS,
  startWarning: MAX_CARD_PROVENANCE_CHARS,
  failureMessage: MAX_FAILURE_MESSAGE_CHARS,
  failureCode: MAX_FAILURE_CODE_CHARS,
  profileDescription: MAX_PROFILE_DESCRIPTION_CHARS,
  profileModel: MAX_PROFILE_MODEL_SELECTOR_CHARS,
  profileReason: MAX_PROFILE_CANDIDATE_REASON_CHARS,
  actionFailureMessage: MAX_ACTION_FAILURE_MESSAGE_CHARS,
  actionFailureId: MAX_ACTION_FAILURE_ID_CHARS,
} as const;

const COMPACT_LIMITS = {
  ...FULL_LIMITS,
  id: 256,
  provenance: 256,
  skipped: 4,
  currentTool: 128,
  progress: 256,
  warning: 256,
  question: 1_024,
  writeClaims: 16,
  observedWrites: 16,
  writeViolations: 8,
  startProfile: 48,
  startWarning: 512,
  failureMessage: 256,
  failureCode: 64,
  profileDescription: 256,
  profileReason: 256,
  actionFailureMessage: 160,
} as const;

const DENSITY_LIMITS = {
  full: FULL_LIMITS,
  compact: COMPACT_LIMITS,
  minimal: {
    ...COMPACT_LIMITS,
    id: 128,
    provenance: 96,
    skipped: 0,
    currentTool: 64,
    progress: 96,
    warning: 96,
    question: 512,
    writeClaims: 4,
    observedWrites: 0,
    writeViolations: 1,
    shortName: 48,
    startProfile: 32,
    startWarning: 160,
    failureMessage: 96,
    failureCode: 48,
    profileDescription: 48,
    profileModel: 24,
    profileReason: 24,
    actionFailureMessage: 96,
    actionFailureId: 64,
  },
} as const;

const DENSITY_ORDER: ReadonlyArray<DetailDensity> = ["full", "compact", "minimal"];

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
export const nonNegativeInteger = (value: number): number => Math.floor(nonNegative(value));

const projectUsage = (usage: SubagentUsage): SubagentRunCard["usage"] => ({
  input: nonNegative(usage.input),
  output: nonNegative(usage.output),
  cacheRead: nonNegative(usage.cacheRead),
  cacheWrite: nonNegative(usage.cacheWrite),
  totalTokens: nonNegative(usage.totalTokens),
  ...(usage.cost !== undefined && { cost: nonNegative(usage.cost) }),
});

const projectSelection = (
  selection: SubagentRunView["selection"],
  density: DetailDensity,
): SubagentRunCard["selection"] => {
  const limits = DENSITY_LIMITS[density];
  const warning = optionalText(selection.warning, limits.provenance);
  return {
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
    ...(selection.candidateIndex !== undefined && {
      candidateIndex: nonNegativeInteger(selection.candidateIndex),
    }),
    ...(warning !== undefined && { warning }),
  };
};

const projectWorkspaceFields = (value: {
  readonly writerWorkspaceMode?: "worktree" | "shared-checkout" | undefined;
  readonly workspaceId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly sourceCwd?: string | undefined;
}) => ({
  ...(value.writerWorkspaceMode !== undefined && {
    writerWorkspaceMode: value.writerWorkspaceMode,
  }),
  ...(value.workspaceId !== undefined && {
    workspaceId: requiredText(value.workspaceId, MAX_PROTOCOL_ID_CHARS, "unknown-workspace"),
  }),
  ...(value.writerWorkspaceMode !== undefined &&
    value.cwd !== undefined && { cwd: requiredText(value.cwd, 1_024, "unknown-cwd") }),
  ...(value.sourceCwd !== undefined && {
    sourceCwd: requiredText(value.sourceCwd, 1_024, "unknown-cwd"),
  }),
});

const projectWriteCardFields = (
  run: SubagentRunView,
  density: DetailDensity,
): Partial<SubagentRunCard> => {
  const limits = DENSITY_LIMITS[density];
  // Minimal density keeps only the single current-offender violation as containment evidence.
  const violationLimit =
    density === "minimal" && !run.writeViolationOffender ? 0 : limits.writeViolations;
  return {
    ...projectWorkspaceFields(run),
    ...(run.writeClaims !== undefined && {
      writeClaims: run.writeClaims
        .slice(0, limits.writeClaims)
        .map((path) => requiredText(path, MAX_WRITE_CLAIM_CHARS, "unknown-file")),
      writeClaimCount: run.writeClaims.length,
      ...(run.writeClaims.length > limits.writeClaims && { writeClaimsOmitted: true as const }),
    }),
    ...(run.writeAudit !== undefined && {
      writeAudit: {
        observedFileWrites: (limits.observedWrites === 0
          ? []
          : run.writeAudit.observedFileWrites.slice(-limits.observedWrites)
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
    }),
    ...(run.writeAdmissionPaused === true && { writeAdmissionPaused: true as const }),
    ...(run.writeViolationOffender === true && { writeViolationOffender: true as const }),
  };
};

const projectOptionalCardFields = (
  run: SubagentRunView,
  density: DetailDensity,
): Partial<SubagentRunCard> => {
  const limits = DENSITY_LIMITS[density];
  const currentTool = optionalText(run.currentTool, limits.currentTool);
  const progress = optionalText(run.progress, limits.progress);
  const warning = optionalText(run.warning, limits.warning);
  const systemWarning = optionalText(run.systemWarning, limits.warning);
  const endedAt = run.endedAt === undefined ? undefined : nonNegative(run.endedAt);
  const question = optionalText(run.question?.message, limits.question);
  return {
    ...(currentTool !== undefined && { currentTool }),
    ...(progress !== undefined && { progress }),
    ...(warning !== undefined && { warning }),
    ...((run.warningSource === "child" || run.warningSource === "system") && {
      warningSource: run.warningSource,
    }),
    ...(systemWarning !== undefined && { systemWarning }),
    ...(run.steeringDelivery !== undefined && { steeringDelivery: run.steeringDelivery }),
    ...(endedAt !== undefined && { endedAt }),
    ...(question !== undefined && { question: { message: question } }),
  };
};

const projectNativeActivity = (
  activity: SubagentRunView["nativeActivity"],
): SubagentRunCard["nativeActivity"] => {
  if (!activity) return undefined;
  const latestId = optionalText(activity.latest?.id, 256);
  return {
    active: nonNegativeInteger(activity.active),
    total: nonNegativeInteger(activity.total),
    ...(activity.latest !== undefined && {
      latest: {
        kind: requiredText(activity.latest.kind, 128, "native-agent"),
        state: activity.latest.state,
        updatedAt: nonNegative(activity.latest.updatedAt),
        ...(latestId !== undefined && { id: latestId }),
      },
    }),
  };
};

const projectReportCardFields = (run: SubagentRunView): Partial<SubagentRunCard> => {
  const finalText = optionalText(run.finalText, MAX_FINAL_TEXT_CHARS);
  const error = optionalText(run.error, MAX_ERROR_CHARS);
  const finalTextTruncated =
    run.finalText !== undefined &&
    finalText?.length !== stripTerminalControls(run.finalText).length;
  const errorTruncated =
    run.error !== undefined && error?.length !== stripTerminalControls(run.error).length;
  return {
    ...(finalText !== undefined && { finalText }),
    ...(error !== undefined && { error }),
    ...(finalTextTruncated && { finalTextTruncated: true as const }),
    ...(errorTruncated && { errorTruncated: true as const }),
  };
};

/** Explicit privacy projection from a run view to persisted renderer fields. */
export const projectSubagentRunCard = (
  run: SubagentRunView,
  density: DetailDensity = "full",
): SubagentRunCard => {
  const limits = DENSITY_LIMITS[density];
  const profile = run.profile && PROFILE_IDS.includes(run.profile) ? run.profile : undefined;
  const parentRunId = optionalText(run.parentRunId, limits.id);
  const nativeActivity = projectNativeActivity(run.nativeActivity);
  return {
    id: requiredText(run.id, limits.id, "unknown-run"),
    name: sanitizeName(run.name) || "subagent",
    state: run.state,
    host: run.host,
    runtime: run.runtime,
    closeOnReport: run.closeOnReport,
    reportGeneration: nonNegativeInteger(run.reportGeneration),
    ...(run.reportStatus !== undefined && { reportStatus: run.reportStatus }),
    model: requiredText(run.model, MAX_CARD_MODEL_CHARS, "unknown-model"),
    effort: SUBAGENT_EFFORTS.includes(run.effort) ? run.effort : ("off" as const),
    openaiFastMode: run.openaiFastMode,
    context: run.context,
    writeIntent: run.writeIntent,
    capabilities: [...run.capabilities],
    startedAt: nonNegative(run.startedAt),
    lastActivityAt: nonNegative(run.lastActivityAt),
    usage: projectUsage(run.usage),
    selection: projectSelection(run.selection, density),
    ...projectWriteCardFields(run, density),
    ...projectOptionalCardFields(run, density),
    ...(parentRunId !== undefined && {
      parentRunId,
      depth: nonNegativeInteger(run.depth ?? 1),
      directChildCount: nonNegativeInteger(run.directChildCount ?? 0),
      descendantCount: nonNegativeInteger(run.descendantCount ?? 0),
    }),
    ...(nativeActivity !== undefined && { nativeActivity }),
    ...(profile !== undefined && { profile }),
    ...projectReportCardFields(run),
  };
};

const omitReports = (card: SubagentRunCard): SubagentRunCard => {
  const { finalText, error, ...summary } = card;
  return {
    ...summary,
    ...(finalText !== undefined && { finalTextTruncated: true as const }),
    ...(error !== undefined && { errorTruncated: true as const }),
  };
};

const projectFailure = (
  failure: SubagentCardFailure,
  density: DetailDensity,
): SubagentCardFailure => {
  const limits = DENSITY_LIMITS[density];
  const name = optionalText(failure.name, limits.shortName);
  const code = optionalText(failure.code, limits.failureCode);
  const message = requiredText(failure.message, limits.failureMessage, "Launch failed.");
  const recovery = failure.admittedRun;
  const admittedRun = recovery
    ? {
        runId: requiredText(recovery.runId, limits.id, "unknown-run"),
        cleanupDisposition: recovery.cleanupDisposition,
        retryDisposition: recovery.retryDisposition,
        remainingCandidateCount: nonNegativeInteger(recovery.remainingCandidateCount),
        hasRemainingCandidate: recovery.hasRemainingCandidate,
      }
    : undefined;
  return {
    index: nonNegativeInteger(failure.index),
    ...(name !== undefined && { name }),
    message,
    ...(code !== undefined && { code }),
    ...(admittedRun !== undefined && { admittedRun }),
  };
};

const projectStartEntry = (
  entry: SubagentStartEntry,
  density: DetailDensity,
): SubagentStartEntry => {
  const limits = DENSITY_LIMITS[density];
  const identity = {
    index: nonNegativeInteger(entry.index),
    name: requiredText(entry.name, limits.shortName, "launch"),
    profile: requiredText(entry.profile, limits.startProfile, "generalist"),
  };
  if (entry.status === "pending")
    return { ...identity, status: "pending", routeStatus: "resolving" };
  if (entry.routeStatus === "unavailable")
    return { ...identity, status: "failed", routeStatus: "unavailable" };
  const warning = optionalText(entry.warning, limits.startWarning);
  const selectedFields = {
    ...projectWorkspaceFields(entry),
    routeStatus: "selected" as const,
    host: entry.host,
    runtime: entry.runtime,
    model: requiredText(entry.model, MAX_CARD_MODEL_CHARS, "unknown-model"),
    effort: entry.effort,
    openaiFastMode: entry.openaiFastMode,
    ...(entry.candidateIndex !== undefined && {
      candidateIndex: nonNegativeInteger(entry.candidateIndex),
    }),
    ...(warning !== undefined && { warning }),
  };
  return entry.status === "started"
    ? {
        ...identity,
        status: "started",
        ...selectedFields,
        runId: requiredText(entry.runId, limits.id, "unknown-run"),
      }
    : { ...identity, status: "failed", ...selectedFields };
};

/** Explicit privacy projection for persisted profile-route discovery. */
export const projectSubagentProfileRoutes = (
  profiles: ReadonlyArray<SubagentProfileView>,
  density: DetailDensity = "full",
): ReadonlyArray<SubagentProfileRouteCard> => {
  const limits = DENSITY_LIMITS[density];
  return profiles.slice(0, PROFILE_IDS.length).map((profile) => ({
    id: profile.id,
    description: requiredText(profile.description, limits.profileDescription, "Profile route."),
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
              limits.profileModel,
              candidate.runtime === "pi" ? "x/y" : "x",
            )
          : requiredText(candidate.model, limits.profileModel, "omitted-model"),
      effort: candidate.effort,
      context: candidate.context,
      writeIntent: candidate.writeIntent,
      openaiFastMode: candidate.openaiFastMode ?? false,
      closeOnReport: candidate.closeOnReport,
      status: candidate.status,
      reason:
        density === "minimal"
          ? boundedAsciiOr(candidate.reason, limits.profileReason, "Omitted.")
          : requiredText(candidate.reason, limits.profileReason, "Route detail omitted."),
    })),
    ...(profile.defaultEffort !== undefined && { defaultEffort: profile.defaultEffort }),
  }));
};

const projectActionFailures = (
  action: RunDetailsAction,
  failures: ReadonlyArray<CompactToolActionFailure> | undefined,
  density: DetailDensity,
): ReadonlyArray<CompactToolActionFailure> | undefined => {
  if (!failures || failures.length === 0) return undefined;
  const limits = DENSITY_LIMITS[density];
  return failures.slice(0, MAX_TARGET_RUNS).map((failure) => {
    const code = optionalText(failure.code, MAX_ACTION_FAILURE_CODE_CHARS);
    // Persist the flag only where it can mean pending; decoders still accept it structurally.
    const pendingDelivery =
      actionFailureDisposition(action, { code, pendingDelivery: failure.pendingDelivery }) ===
      "pending";
    return {
      id: requiredText(failure.id, limits.actionFailureId, "unknown-run"),
      ...(code !== undefined && { code }),
      message: requiredText(failure.message, limits.actionFailureMessage, "Action failed."),
      ...(pendingDelivery && { pendingDelivery: true as const }),
    };
  });
};

const semanticCandidate = <Stage, Candidate, Details>(
  stages: ReadonlyArray<Stage>,
  project: (stage: Stage) => Candidate,
  decode: (candidate: Candidate) => Details | undefined,
): Details => {
  for (const stage of stages) {
    const decoded = decode(project(stage));
    if (decoded !== undefined) return decoded;
  }
  throw new Error("Unable to construct bounded persisted subagent details.");
};

const startDetailsCandidate = (
  input: StartDetailsInput,
  density: DetailDensity,
): SubagentStartDetails => {
  const failures = input.startFailures
    ? [...input.startFailures]
        .sort((left, right) => left.index - right.index)
        .slice(0, MAX_START_BATCH)
        .map((failure) => projectFailure(failure, density))
    : undefined;
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "start",
    startEntries: input.startEntries
      .slice(0, MAX_START_BATCH)
      .map((entry) => projectStartEntry(entry, density)),
    ...(failures !== undefined && failures.length > 0 && { startFailures: failures }),
  };
};

/** Makes strict version-2 start details. Start details never persist run cards. */
export const makeStartDetails = (input: StartDetailsInput): SubagentStartDetails =>
  semanticCandidate(
    DENSITY_ORDER,
    (density) => startDetailsCandidate(input, density),
    (value) => {
      const decoded = decodeStartAwaitCardDetails(value);
      return decoded?.action === "start" ? decoded : undefined;
    },
  );

const reportsWereOmitted = (runs: ReadonlyArray<SubagentRunView>): boolean =>
  runs.some((run) => run.finalText !== undefined || run.error !== undefined);

const projectedCards = (
  runs: ReadonlyArray<SubagentRunView>,
  density: DetailDensity,
  includeReports: boolean,
): ReadonlyArray<SubagentRunCard> =>
  runs.slice(0, MAX_TARGET_RUNS).map((run) => {
    const card = projectSubagentRunCard(run, density);
    return includeReports ? card : omitReports(card);
  });

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
  const targetCards = projectedCards(source, density, includeReports);
  const contextCards = projectedCards(contextSource, density, false);
  const awaitedRunIds =
    targetCards.length > 0 ? targetCards.map((card) => card.id) : requestedAwaitedRunIds;
  const omitted = !includeReports && reportsWereOmitted(source);
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "await",
    cards: [...targetCards, ...contextCards],
    awaitedRunIds,
    awaitUntil: input.awaitUntil,
    ...(input.attentionRequired && { attentionRequired: true as const }),
    ...(input.cancelled && { cancelled: true as const }),
    ...(input.cancelled &&
      input.cancellationCleanup === "unconfirmed" && {
        cancellationCleanup: "unconfirmed" as const,
      }),
    ...(contextCandidates.length > contextSource.length && { contextOmitted: true as const }),
    ...(omitted && { contentOmitted: true as const }),
    ...(omitted &&
      density === "full" &&
      ![...source, ...contextSource].some((run) => run.error !== undefined) && {
        reportsOnlyOmitted: true as const,
      }),
  };
};

/** Makes strict version-2 await details with semantic fitting stages. */
export const makeAwaitDetails = (input: AwaitDetailsInput): SubagentAwaitDetails =>
  semanticCandidate(
    ["reports", ...DENSITY_ORDER] as const,
    (stage) => awaitCandidate(input, stage === "reports" ? "full" : stage, stage === "reports"),
    (value) => {
      const decoded = decodeStartAwaitCardDetails(value);
      return decoded?.action === "await" ? decoded : undefined;
    },
  );

const runDetailsCandidate = (
  input: Extract<CompactToolDetailsInput, { readonly action: RunDetailsAction }>,
  density: DetailDensity,
  includeReports: boolean,
): Exclude<CompactSubagentToolDetails, { readonly action: "models" }> => {
  const orderedRuns =
    input.action === "list" ? projectRunCardTree(input.runs).map((row) => row.run) : input.runs;
  const source = orderedRuns.slice(0, MAX_TARGET_RUNS);
  const cards = projectedCards(source, density, includeReports);
  const failures = projectActionFailures(input.action, input.actionFailures, density);
  const omitted = !includeReports && reportsWereOmitted(source);
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: input.action,
    cards,
    runCount: input.runs.length,
    ...(failures !== undefined && failures.length > 0 && { actionFailures: failures }),
    ...(omitted && { contentOmitted: true as const }),
    ...(omitted &&
      density === "full" &&
      !input.runs.some((run) => run.error !== undefined) &&
      !input.actionFailures?.length && { reportsOnlyOmitted: true as const }),
  };
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
      DENSITY_ORDER,
      (density) => modelDetailsCandidate(input, density),
      decodeCompactToolDetails,
    );
  return semanticCandidate(
    input.action === "status" ? (["reports", ...DENSITY_ORDER] as const) : DENSITY_ORDER,
    (stage) =>
      runDetailsCandidate(input, stage === "reports" ? "full" : stage, stage === "reports"),
    decodeCompactToolDetails,
  );
};
