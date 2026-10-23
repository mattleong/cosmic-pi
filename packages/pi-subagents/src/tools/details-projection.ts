import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { safeTextPrefix } from "pi-cosmic-core/text";
import {
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core/security";
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import {
  MAX_CUSTOM_AGENT_DESCRIPTION_CHARS,
  MAX_CUSTOM_AGENT_NAME_CHARS,
  MAX_RESOLVED_CUSTOM_AGENTS,
} from "../profiles/agents.ts";
import {
  MAX_PROFILE_CANDIDATES,
  MAX_PROFILE_MODEL_SELECTOR_CHARS,
  PROFILE_IDS,
  type SubagentModelOverride,
} from "../profiles/model.ts";
import {
  MAX_OUTCOME_DIFFSTAT_FILES,
  type SubagentReportArchive,
  type SubagentRunView,
  type SubagentUsage,
  type SubagentWorkspaceDiffStat,
} from "../run/model.ts";
import { MAX_PROTOCOL_ID_CHARS, MAX_TARGET_RUNS } from "../run/limits.ts";
import {
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  MAX_NAME_CHARS,
  sanitizeName,
} from "../run/state.ts";
import {
  MAX_CLEANUP_DIAGNOSTIC_CODE_CHARS,
  MAX_CLEANUP_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_CARD_DIFFSTAT_PATH_CHARS,
  MAX_CARD_MODEL_CHARS,
  MAX_CARD_PATH_CHARS,
  MAX_CARD_PROVENANCE_CHARS,
  MAX_CARD_QUESTION_CHARS,
  MAX_CARD_SKIPS,
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
  MAX_INVALID_AGENT_ENTRIES,
  MAX_WARNING_CHARS,
  type CompactToolActionFailure,
  type InvalidAgentCard,
  type ModelOverrideCard,
  type SubagentAgentRouteCard,
  type SubagentCardFailure,
  type SubagentProfileRouteCard,
  type SubagentRunCard,
  type SubagentStartEntry,
  type WorkspaceDiffStatCard,
} from "./details-schema.ts";
import type {
  ProfileCandidateDiscovery,
  SubagentAgentView,
  SubagentInvalidAgentView,
  SubagentProfileView,
} from "./model.ts";

// Collapsed issue messages quote at most 120 characters, so condensed text keeps them complete.
const CONDENSED_TEXT_CHARS = 256;

const clean = (value: string, maximum: number): string =>
  safeTextPrefix(Fn.pipe(stripTerminalControls(value), Str.replaceAll("\u0000", "")), maximum);
const requiredText = (value: string, maximum: number, fallback: string): string =>
  Str.trim(clean(value, maximum)) || fallback;
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
): SubagentRunCard["selection"] => {
  const warning = optionalText(selection.warning, MAX_CARD_PROVENANCE_CHARS);
  return {
    source: selection.source,
    reason: requiredText(
      selection.reason,
      MAX_CARD_PROVENANCE_CHARS,
      "Route selection detail unavailable.",
    ),
    skippedCandidates: Arr.map(
      selection.skippedCandidates.slice(0, MAX_CARD_SKIPS),
      (candidate) => ({
        candidate: {
          runtime: candidate.candidate.runtime,
          model: requiredText(
            candidate.candidate.model,
            Math.min(MAX_CARD_PROVENANCE_CHARS, MAX_CARD_MODEL_CHARS),
            "unknown-model",
          ),
          effort: candidate.candidate.effort,
        },
        code: requiredText(candidate.code, MAX_FAILURE_CODE_CHARS, "unavailable"),
        reason: requiredText(candidate.reason, MAX_CARD_PROVENANCE_CHARS, "Unavailable."),
      }),
    ),
    ...(selection.candidateIndex !== undefined && {
      candidateIndex: nonNegativeInteger(selection.candidateIndex),
    }),
    ...(warning !== undefined && { warning }),
  };
};

export const projectModelOverride = (
  override: SubagentModelOverride | undefined,
): { readonly modelOverride?: ModelOverrideCard } =>
  override === undefined
    ? {}
    : {
        modelOverride: {
          runtime: override.runtime,
          model: requiredText(override.model, MAX_CARD_MODEL_CHARS, "unknown-model"),
          ...(override.effort !== undefined && { effort: override.effort }),
        },
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

const projectDiffStatFile = (
  file: SubagentWorkspaceDiffStat["files"][number],
): WorkspaceDiffStatCard["files"][number] => ({
  path: requiredText(file.path, MAX_CARD_DIFFSTAT_PATH_CHARS, "unknown-path"),
  addedLines: nonNegativeInteger(file.addedLines),
  deletedLines: nonNegativeInteger(file.deletedLines),
  ...(file.binary && { binary: true as const }),
});

const projectWorkspaceOutcome = (
  outcome: SubagentRunView["workspaceOutcome"],
): SubagentRunCard["workspaceOutcome"] => {
  if (outcome?.status !== "proposal") return outcome && { status: outcome.status };
  const stat = outcome.diffStat;
  return {
    status: "proposal",
    changedFileCount: nonNegativeInteger(outcome.changedFileCount),
    ...(outcome.uncapturedFileCount !== undefined && {
      uncapturedFileCount: nonNegativeInteger(outcome.uncapturedFileCount),
    }),
    ...(stat !== undefined && {
      diffStat: {
        addedLines: nonNegativeInteger(stat.addedLines),
        deletedLines: nonNegativeInteger(stat.deletedLines),
        files: Arr.map(stat.files.slice(0, MAX_OUTCOME_DIFFSTAT_FILES), projectDiffStatFile),
      },
    }),
  };
};

// Keep complete bounded cleanup evidence, even when condensed; it gates safe recovery.
export const projectRunCleanup = (
  cleanup: SubagentRunView["cleanup"],
): SubagentRunCard["cleanup"] => {
  if (cleanup === undefined) return undefined;
  const diagnostic = cleanup.diagnostic;
  const code =
    diagnostic?.code === undefined
      ? undefined
      : Str.trim(
          sanitizeDiagnosticContent(diagnostic.code, {
            maximumLength: MAX_CLEANUP_DIAGNOSTIC_CODE_CHARS,
          }),
        );
  return {
    disposition: cleanup.disposition,
    ...(cleanup.recovery !== undefined && { recovery: cleanup.recovery }),
    ...(diagnostic !== undefined && {
      diagnostic: {
        phase: diagnostic.phase,
        ...(code && { code }),
        message:
          Str.trim(
            sanitizeDiagnosticContent(diagnostic.message, {
              maximumLength: MAX_CLEANUP_DIAGNOSTIC_MESSAGE_CHARS,
            }),
          ) || "Cleanup verification detail unavailable.",
      },
    }),
  };
};

const projectWriteCardFields = (run: SubagentRunView): Partial<SubagentRunCard> => {
  const cleanup = projectRunCleanup(run.cleanup);
  const workspaceOutcome = projectWorkspaceOutcome(run.workspaceOutcome);
  return {
    ...(cleanup !== undefined && { cleanup }),
    ...(workspaceOutcome !== undefined && { workspaceOutcome }),
    ...(run.writerCleanupQuarantined !== undefined && {
      writerCleanupQuarantined: run.writerCleanupQuarantined,
    }),
    ...projectWorkspaceFields(run),
  };
};

const projectOptionalCardFields = (run: SubagentRunView): Partial<SubagentRunCard> => {
  const currentTool = optionalText(run.currentTool, MAX_CURRENT_TOOL_CHARS);
  const progress = optionalText(run.progress, MAX_PROGRESS_CHARS);
  const warning = optionalText(run.warning, MAX_WARNING_CHARS);
  const systemWarning = optionalText(run.systemWarning, MAX_WARNING_CHARS);
  const endedAt = run.endedAt === undefined ? undefined : nonNegative(run.endedAt);
  const question = optionalText(run.question?.message, MAX_CARD_QUESTION_CHARS);
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

/** A saved report's file, as cards and the tool contract carry it; a clipped path names no file. */
export const projectReportFile = (
  archive: SubagentReportArchive | undefined,
): SubagentReportArchive | undefined => {
  const path = archive === undefined ? "" : sanitizeTerminalLine(archive.path);
  return archive !== undefined && path && path.length <= MAX_CARD_PATH_CHARS
    ? {
        path,
        chars: nonNegativeInteger(archive.chars),
        lines: nonNegativeInteger(archive.lines),
        complete: archive.complete,
      }
    : undefined;
};

/** A report's file and any cut capture made to the text the card keeps. */
const projectReportRetention = (
  run: SubagentRunView,
): Pick<SubagentRunCard, "reportTruncation" | "reportArchive"> => {
  const truncation = run.finalTextTruncation;
  const reportArchive = projectReportFile(run.reportArchive);
  return {
    ...(truncation !== undefined && {
      reportTruncation: {
        retainedChars: nonNegativeInteger(truncation.retainedChars),
        originalChars: nonNegativeInteger(truncation.originalChars),
        originalLines: nonNegativeInteger(truncation.originalLines),
      },
    }),
    ...(reportArchive !== undefined && { reportArchive }),
  };
};

const projectReportCardFields = (run: SubagentRunView): Partial<SubagentRunCard> => {
  const finalText = optionalText(run.finalText, MAX_FINAL_TEXT_CHARS);
  const error = optionalText(run.error, MAX_ERROR_CHARS);
  // Capture may already have cut the report before this projection bounds it again.
  const finalTextTruncated =
    run.finalText !== undefined &&
    (run.finalTextTruncation !== undefined ||
      finalText?.length !== stripTerminalControls(run.finalText).length);
  const errorTruncated =
    run.error !== undefined && error?.length !== stripTerminalControls(run.error).length;
  return {
    ...(finalText !== undefined && { finalText }),
    ...(error !== undefined && { error }),
    ...(finalTextTruncated && { finalTextTruncated: true as const }),
    ...(errorTruncated && { errorTruncated: true as const }),
    ...(run.finalText !== undefined && projectReportRetention(run)),
  };
};

export const projectSubagentRunCard = (run: SubagentRunView): SubagentRunCard => {
  const profile = run.profile && PROFILE_IDS.includes(run.profile) ? run.profile : undefined;
  const agent = optionalText(run.agent, MAX_CUSTOM_AGENT_NAME_CHARS);
  const parentRunId = optionalText(run.parentRunId, MAX_PROTOCOL_ID_CHARS);
  const nativeActivity = projectNativeActivity(run.nativeActivity);
  return {
    id: requiredText(run.id, MAX_PROTOCOL_ID_CHARS, "unknown-run"),
    name: sanitizeName(run.name) || "subagent",
    state: run.state,
    runtime: run.runtime,
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
    selection: projectSelection(run.selection),
    ...projectModelOverride(run.modelOverride),
    ...projectWriteCardFields(run),
    ...projectOptionalCardFields(run),
    ...(parentRunId !== undefined && {
      parentRunId,
      depth: nonNegativeInteger(run.depth ?? 1),
      directChildCount: nonNegativeInteger(run.directChildCount ?? 0),
      descendantCount: nonNegativeInteger(run.descendantCount ?? 0),
    }),
    ...(nativeActivity !== undefined && { nativeActivity }),
    ...(profile !== undefined && { profile }),
    ...(agent !== undefined && { agent }),
    ...projectReportCardFields(run),
  };
};

export const omitReports = (card: SubagentRunCard): SubagentRunCard => {
  const { finalText, error, ...summary } = card;
  return {
    ...summary,
    ...(finalText !== undefined && { finalTextTruncated: true as const }),
    ...(error !== undefined && { errorTruncated: true as const }),
  };
};

const condensed = (text: string): string => safeTextPrefix(text, CONDENSED_TEXT_CHARS);

/**
 * The report-free fallback when bounded cards still do not fit: drops live activity, skipped
 * route candidates, and diffstat path lists, and shortens issue text.
 * IDs, counts, admission evidence, cleanup, and workspace recovery fields stay complete.
 */
export const condenseRunCard = (card: SubagentRunCard): SubagentRunCard => {
  const {
    currentTool: _currentTool,
    progress: _progress,
    selection,
    warning,
    systemWarning,
    question,
    workspaceOutcome,
    ...essential
  } = omitReports(card);
  return {
    ...essential,
    ...(workspaceOutcome !== undefined && {
      workspaceOutcome:
        workspaceOutcome.status === "proposal" && workspaceOutcome.diffStat !== undefined
          ? { ...workspaceOutcome, diffStat: { ...workspaceOutcome.diffStat, files: [] } }
          : workspaceOutcome,
    }),
    selection: {
      source: selection.source,
      reason: condensed(selection.reason),
      skippedCandidates: [],
      ...(selection.candidateIndex !== undefined && { candidateIndex: selection.candidateIndex }),
      ...(selection.warning !== undefined && { warning: condensed(selection.warning) }),
    },
    ...(warning !== undefined && { warning: condensed(warning) }),
    ...(systemWarning !== undefined && { systemWarning: condensed(systemWarning) }),
    ...(question !== undefined && { question: { message: condensed(question.message) } }),
  };
};

export const projectFailure = (failure: SubagentCardFailure): SubagentCardFailure => {
  const name = optionalText(failure.name, MAX_NAME_CHARS);
  const code = optionalText(failure.code, MAX_FAILURE_CODE_CHARS);
  const message = requiredText(failure.message, MAX_FAILURE_MESSAGE_CHARS, "Launch failed.");
  const recovery = failure.admittedRun;
  const next = recovery?.nextCandidate;
  const admittedRun = recovery
    ? {
        runId: requiredText(recovery.runId, MAX_PROTOCOL_ID_CHARS, "unknown-run"),
        cleanupDisposition: recovery.cleanupDisposition,
        ...(next !== undefined && {
          nextCandidate:
            next === "none"
              ? next
              : {
                  runtime: next.runtime,
                  model: requiredText(next.model, MAX_CARD_MODEL_CHARS, "unknown-model"),
                  effort: next.effort,
                },
        }),
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

export const condenseFailure = (failure: SubagentCardFailure): SubagentCardFailure => ({
  ...failure,
  message: condensed(failure.message),
});

export const projectStartEntry = (entry: SubagentStartEntry): SubagentStartEntry => {
  const agent = optionalText(entry.agent, MAX_CUSTOM_AGENT_NAME_CHARS);
  const identity = {
    index: nonNegativeInteger(entry.index),
    name: requiredText(entry.name, MAX_NAME_CHARS, "launch"),
    profile: requiredText(entry.profile, MAX_PROFILE_CHARS, "generalist"),
    ...(agent !== undefined && { agent }),
  };
  if (entry.status === "pending")
    return { ...identity, status: "pending", routeStatus: "resolving" };
  if (entry.routeStatus === "unavailable")
    return { ...identity, status: "failed", routeStatus: "unavailable" };
  const warning = optionalText(entry.warning, MAX_CARD_PROVENANCE_CHARS);
  const selectedFields = {
    ...projectWorkspaceFields(entry),
    routeStatus: "selected" as const,
    runtime: entry.runtime,
    model: requiredText(entry.model, MAX_CARD_MODEL_CHARS, "unknown-model"),
    effort: entry.effort,
    openaiFastMode: entry.openaiFastMode,
    ...(entry.candidateIndex !== undefined && {
      candidateIndex: nonNegativeInteger(entry.candidateIndex),
    }),
    ...(warning !== undefined && { warning }),
    ...projectModelOverride(entry.modelOverride),
  };
  return entry.status === "started"
    ? {
        ...identity,
        status: "started",
        ...selectedFields,
        runId: requiredText(entry.runId, MAX_PROTOCOL_ID_CHARS, "unknown-run"),
      }
    : { ...identity, status: "failed", ...selectedFields };
};

export const condenseStartEntry = (entry: SubagentStartEntry): SubagentStartEntry =>
  entry.routeStatus === "selected" && entry.warning !== undefined
    ? { ...entry, warning: condensed(entry.warning) }
    : entry;

const projectCandidateCards = (candidates: ReadonlyArray<ProfileCandidateDiscovery>) =>
  Arr.map(candidates.slice(0, MAX_PROFILE_CANDIDATES), (candidate) => ({
    runtime: candidate.runtime,
    model: requiredText(candidate.model, MAX_PROFILE_MODEL_SELECTOR_CHARS, "omitted-model"),
    effort: candidate.effort,
    context: candidate.context,
    writeIntent: candidate.writeIntent,
    openaiFastMode: candidate.openaiFastMode ?? false,
    status: candidate.status,
    reason: requiredText(
      candidate.reason,
      MAX_PROFILE_CANDIDATE_REASON_CHARS,
      "Route detail omitted.",
    ),
  }));

const projectProfileRouteCard = (profile: SubagentProfileView): SubagentProfileRouteCard => ({
  id: profile.id,
  description: requiredText(profile.description, MAX_PROFILE_DESCRIPTION_CHARS, "Profile route."),
  source: profile.source,
  isDefault: profile.isDefault,
  defaultContext: profile.defaultContext,
  defaultWriteIntent: profile.defaultWriteIntent,
  candidates: projectCandidateCards(profile.candidates),
  ...(profile.defaultEffort !== undefined && { defaultEffort: profile.defaultEffort }),
});

const projectAgentRouteCard = (agent: SubagentAgentView): SubagentAgentRouteCard => ({
  name: requiredText(agent.name, MAX_CUSTOM_AGENT_NAME_CHARS, "agent"),
  description: requiredText(agent.description, MAX_CUSTOM_AGENT_DESCRIPTION_CHARS, "Custom agent."),
  profile: agent.profile,
  source: agent.source,
  ...(agent.effort !== undefined && { effort: agent.effort }),
  ...(agent.context !== undefined && { context: agent.context }),
  ...(agent.writeIntent !== undefined && { writeIntent: agent.writeIntent }),
  ...(agent.isolation !== undefined && { isolation: agent.isolation }),
  ...(agent.tools?.allow !== undefined && { allowedToolCount: agent.tools.allow.length }),
  ...(agent.tools?.deny !== undefined && { deniedToolCount: agent.tools.deny.length }),
  candidates: projectCandidateCards(agent.candidates),
});

export const projectSubagentAgentRoutes = (
  agents: ReadonlyArray<SubagentAgentView>,
): ReadonlyArray<SubagentAgentRouteCard> =>
  Arr.map(agents.slice(0, MAX_RESOLVED_CUSTOM_AGENTS), projectAgentRouteCard);

export const projectInvalidAgents = (
  invalid: ReadonlyArray<SubagentInvalidAgentView>,
): ReadonlyArray<InvalidAgentCard> =>
  Arr.map(invalid.slice(0, MAX_INVALID_AGENT_ENTRIES), (entry) => {
    const name = optionalText(entry.name, MAX_CUSTOM_AGENT_NAME_CHARS);
    return name === undefined ? { scope: entry.scope } : { scope: entry.scope, name };
  });

export const condenseAgentRoute = (agent: SubagentAgentRouteCard): SubagentAgentRouteCard => ({
  ...agent,
  description: condensed(agent.description),
  candidates: Arr.map(agent.candidates, (candidate) => ({
    ...candidate,
    reason: condensed(candidate.reason),
  })),
});

export const projectSubagentProfileRoutes = (
  profiles: ReadonlyArray<SubagentProfileView>,
): ReadonlyArray<SubagentProfileRouteCard> =>
  Arr.map(profiles.slice(0, PROFILE_IDS.length), projectProfileRouteCard);

export const condenseProfileRoute = (
  profile: SubagentProfileRouteCard,
): SubagentProfileRouteCard => ({
  ...profile,
  description: condensed(profile.description),
  candidates: Arr.map(profile.candidates, (candidate) => ({
    ...candidate,
    reason: condensed(candidate.reason),
  })),
});

const projectActionFailure = (failure: CompactToolActionFailure): CompactToolActionFailure => {
  const code = optionalText(failure.code, MAX_ACTION_FAILURE_CODE_CHARS);
  return {
    id: requiredText(failure.id, MAX_ACTION_FAILURE_ID_CHARS, "unknown-run"),
    ...(code !== undefined && { code }),
    message: requiredText(failure.message, MAX_ACTION_FAILURE_MESSAGE_CHARS, "Action failed."),
  };
};

export const projectActionFailures = (
  failures: ReadonlyArray<CompactToolActionFailure> | undefined,
): ReadonlyArray<CompactToolActionFailure> | undefined => {
  if (!failures || failures.length === 0) return undefined;
  return Arr.map(failures.slice(0, MAX_TARGET_RUNS), projectActionFailure);
};
