import type { ProfileId } from "../profiles/model.ts";
import type { SubagentRunView } from "../run/model.ts";
import { MAX_START_BATCH, MAX_TARGET_RUNS } from "../run/limits.ts";
import { projectRunCardTree } from "../ui/run-tree-rows.ts";
import {
  SUBAGENT_CARD_DETAILS_VERSION,
  type CompactSubagentToolDetails,
  type CompactToolActionFailure,
  type RunDetailsAction,
  type SubagentAwaitDetails,
  type SubagentCardFailure,
  type SubagentRunCard,
  type SubagentStartDetails,
  type SubagentStartEntry,
} from "./details-schema.ts";
import { decodeCompactToolDetails, decodeStartAwaitCardDetails } from "./details-decode.ts";
import {
  condenseAgentRoute,
  condenseFailure,
  condenseProfileRoute,
  condenseRunCard,
  condenseStartEntry,
  omitReports,
  projectActionFailures,
  projectFailure,
  projectInvalidAgents,
  projectStartEntry,
  projectSubagentAgentRoutes,
  projectSubagentProfileRoutes,
  projectSubagentRunCard,
} from "./details-projection.ts";
import type { SubagentAgentView, SubagentInvalidAgentView, SubagentProfileView } from "./model.ts";

export interface StartDetailsInput {
  readonly startEntries: ReadonlyArray<SubagentStartEntry>;
  readonly startFailures?: ReadonlyArray<SubagentCardFailure> | undefined;
}

export interface AwaitDetailsInput {
  readonly runs: ReadonlyArray<SubagentRunView>;
  readonly contextRuns?: ReadonlyArray<SubagentRunView> | undefined;
  readonly awaitedRunIds?: ReadonlyArray<string> | undefined;
  readonly awaitUntil: "all_finished" | "any_finished";
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  readonly timedOutSeconds?: number | undefined;
  readonly endedByUserInput?: true | undefined;
  readonly cancellationCleanup?: "unconfirmed" | undefined;
}

export type CompactToolDetailsInput =
  | {
      readonly action: "models";
      readonly profiles: ReadonlyArray<SubagentProfileView>;
      readonly agents?: ReadonlyArray<SubagentAgentView> | undefined;
      readonly invalidAgents?: ReadonlyArray<SubagentInvalidAgentView> | undefined;
      readonly fallbackProfile: ProfileId;
    }
  | {
      readonly action: RunDetailsAction;
      readonly runs: ReadonlyArray<SubagentRunView>;
      readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
      readonly answeredRunIds?: ReadonlyArray<string> | undefined;
    };

/**
 * Fitting stages, tried in order until details decode within their persisted bound: bounded cards
 * with reports, then without reports, then condensed to their essential evidence.
 */
type FitStage = "reports" | "report-free" | "condensed";
const REPORT_STAGES: ReadonlyArray<FitStage> = ["reports", "report-free", "condensed"];
const REPORT_FREE_STAGES: ReadonlyArray<FitStage> = ["report-free", "condensed"];

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

const startDetailsCandidate = (input: StartDetailsInput, stage: FitStage): SubagentStartDetails => {
  const condense = stage === "condensed";
  const failures = input.startFailures
    ? [...input.startFailures]
        .toSorted((left, right) => left.index - right.index)
        .slice(0, MAX_START_BATCH)
        .map((failure) => {
          const projected = projectFailure(failure);
          return condense ? condenseFailure(projected) : projected;
        })
    : undefined;
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "start",
    startEntries: input.startEntries.slice(0, MAX_START_BATCH).map((entry) => {
      const projected = projectStartEntry(entry);
      return condense ? condenseStartEntry(projected) : projected;
    }),
    ...(failures !== undefined && failures.length > 0 && { startFailures: failures }),
  };
};

export const startDetails = (input: StartDetailsInput): SubagentStartDetails =>
  semanticCandidate(
    REPORT_FREE_STAGES,
    (stage) => startDetailsCandidate(input, stage),
    (value) => {
      const decoded = decodeStartAwaitCardDetails(value);
      return decoded?.action === "start" ? decoded : undefined;
    },
  );

const reportsWereOmitted = (runs: ReadonlyArray<SubagentRunView>): boolean =>
  runs.some((run) => run.finalText !== undefined || run.error !== undefined);

const projectedCards = (
  runs: ReadonlyArray<SubagentRunView>,
  stage: FitStage,
): ReadonlyArray<SubagentRunCard> =>
  runs.slice(0, MAX_TARGET_RUNS).map((run) => {
    const card = projectSubagentRunCard(run);
    if (stage === "reports") return card;
    return stage === "report-free" ? omitReports(card) : condenseRunCard(card);
  });

const awaitCandidate = (input: AwaitDetailsInput, stage: FitStage): SubagentAwaitDetails => {
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
  const targetCards = projectedCards(source, stage);
  const contextCards = projectedCards(contextSource, stage === "reports" ? "report-free" : stage);
  const awaitedRunIds =
    targetCards.length > 0 ? targetCards.map((card) => card.id) : requestedAwaitedRunIds;
  const reportsOmitted = stage === "report-free" && reportsWereOmitted(source);
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "await",
    cards: [...targetCards, ...contextCards],
    awaitedRunIds,
    awaitUntil: input.awaitUntil,
    ...(input.attentionRequired && { attentionRequired: true as const }),
    ...(input.cancelled && { cancelled: true as const }),
    ...(input.cancelled &&
      input.timedOutSeconds !== undefined && { timedOutSeconds: input.timedOutSeconds }),
    ...(input.cancelled && input.endedByUserInput && { endedByUserInput: true as const }),
    ...(input.cancelled &&
      input.cancellationCleanup === "unconfirmed" && {
        cancellationCleanup: "unconfirmed" as const,
      }),
    ...(contextCandidates.length > contextSource.length && { contextOmitted: true as const }),
    ...((reportsOmitted || stage === "condensed") && { contentOmitted: true as const }),
    ...(reportsOmitted &&
      ![...source, ...contextSource].some((run) => run.error !== undefined) && {
        reportsOnlyOmitted: true as const,
      }),
  };
};

export const awaitDetails = (input: AwaitDetailsInput): SubagentAwaitDetails =>
  semanticCandidate(
    REPORT_STAGES,
    (stage) => awaitCandidate(input, stage),
    (value) => {
      const decoded = decodeStartAwaitCardDetails(value);
      return decoded?.action === "await" ? decoded : undefined;
    },
  );

const runDetailsCandidate = (
  input: Extract<CompactToolDetailsInput, { readonly action: RunDetailsAction }>,
  stage: FitStage,
): Exclude<CompactSubagentToolDetails, { readonly action: "models" }> => {
  const orderedRuns =
    input.action === "list" ? projectRunCardTree(input.runs).map((row) => row.run) : input.runs;
  const source = orderedRuns.slice(0, MAX_TARGET_RUNS);
  const cards = projectedCards(source, stage);
  const failures = projectActionFailures(input.action, input.actionFailures);
  const reportsOmitted = stage === "report-free" && reportsWereOmitted(source);
  const answeredRunIds = (input.answeredRunIds ?? []).slice(0, MAX_TARGET_RUNS);
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: input.action,
    cards,
    runCount: input.runs.length,
    ...(answeredRunIds.length > 0 && { answeredRunIds }),
    ...(failures !== undefined && failures.length > 0 && { actionFailures: failures }),
    ...((reportsOmitted || stage === "condensed") && { contentOmitted: true as const }),
    ...(reportsOmitted &&
      !input.runs.some((run) => run.error !== undefined) &&
      !input.actionFailures?.length && { reportsOnlyOmitted: true as const }),
  };
};

const modelDetailsCandidate = (
  input: Extract<CompactToolDetailsInput, { readonly action: "models" }>,
  stage: FitStage,
): Extract<CompactSubagentToolDetails, { readonly action: "models" }> => {
  const profiles = projectSubagentProfileRoutes(input.profiles);
  const agents = projectSubagentAgentRoutes(input.agents ?? []);
  const invalidAgents = projectInvalidAgents(input.invalidAgents ?? []);
  const base: Extract<CompactSubagentToolDetails, { readonly action: "models" }> = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "models",
    profiles: stage === "condensed" ? profiles.map(condenseProfileRoute) : profiles,
    ...(agents.length > 0 && {
      agents: stage === "condensed" ? agents.map(condenseAgentRoute) : agents,
    }),
    ...(invalidAgents.length > 0 && { invalidAgents }),
    fallbackProfile: input.fallbackProfile,
  };
  return stage === "condensed" ? { ...base, contentOmitted: true as const } : base;
};

export const compactToolDetails = (input: CompactToolDetailsInput): CompactSubagentToolDetails => {
  if (input.action === "models")
    return semanticCandidate(
      REPORT_FREE_STAGES,
      (stage) => modelDetailsCandidate(input, stage),
      decodeCompactToolDetails,
    );
  return semanticCandidate(
    input.action === "status" ? REPORT_STAGES : REPORT_FREE_STAGES,
    (stage) => runDetailsCandidate(input, stage),
    decodeCompactToolDetails,
  );
};
