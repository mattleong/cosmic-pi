import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
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

interface StartDetailsInput {
  readonly startEntries: ReadonlyArray<SubagentStartEntry>;
  readonly startFailures?: ReadonlyArray<SubagentCardFailure> | undefined;
}

interface AwaitDetailsInput {
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

interface ModelDetailsInput {
  readonly profiles: ReadonlyArray<SubagentProfileView>;
  readonly agents?: ReadonlyArray<SubagentAgentView> | undefined;
  readonly invalidAgents?: ReadonlyArray<SubagentInvalidAgentView> | undefined;
  readonly fallbackProfile: ProfileId;
}

interface RunDetailsInput {
  readonly action: RunDetailsAction;
  readonly runs: ReadonlyArray<SubagentRunView>;
  readonly actionFailures?: ReadonlyArray<CompactToolActionFailure> | undefined;
}

type ModelDetails = Extract<CompactSubagentToolDetails, { readonly action: "models" }>;

/**
 * Fitting stages, tried in order until details decode within their persisted bound: bounded cards
 * with reports, then without reports, then condensed to their essential evidence.
 */
type FitStage = "reports" | "report-free" | "condensed";
const REPORT_STAGES: ReadonlyArray<FitStage> = ["reports", "report-free", "condensed"];
const REPORT_FREE_STAGES: ReadonlyArray<FitStage> = ["report-free", "condensed"];

const fittedCandidate = <Stage, Candidate, Details>(
  stages: ReadonlyArray<Stage>,
  project: (stage: Stage) => Candidate,
  decode: (candidate: Candidate) => Details | undefined,
): Details | undefined => {
  for (const stage of stages) {
    const decoded = decode(project(stage));
    if (decoded !== undefined) return decoded;
  }
  return undefined;
};

const semanticCandidate = <Stage, Candidate, Details>(
  stages: ReadonlyArray<Stage>,
  project: (stage: Stage) => Candidate,
  decode: (candidate: Candidate) => Details | undefined,
): Details => {
  const fitted = fittedCandidate(stages, project, decode);
  if (fitted !== undefined) return fitted;
  throw new Error("Unable to construct bounded persisted subagent details.");
};

const startDetailsCandidate = (input: StartDetailsInput, stage: FitStage): SubagentStartDetails => {
  const condense = stage === "condensed";
  const failures = input.startFailures
    ? Arr.map(
        Arr.sortWith([...input.startFailures], (failure) => failure.index, Order.Number).slice(
          0,
          MAX_START_BATCH,
        ),
        (failure) => {
          const projected = projectFailure(failure);
          return condense ? condenseFailure(projected) : projected;
        },
      )
    : undefined;
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "start",
    startEntries: Arr.map(input.startEntries.slice(0, MAX_START_BATCH), (entry) => {
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
  Arr.some(runs, (run) => run.finalText !== undefined || run.error !== undefined);

const projectedCards = (
  runs: ReadonlyArray<SubagentRunView>,
  stage: FitStage,
): ReadonlyArray<SubagentRunCard> =>
  Arr.map(runs.slice(0, MAX_TARGET_RUNS), (run) => {
    const card = projectSubagentRunCard(run);
    if (stage === "reports") return card;
    return stage === "report-free" ? omitReports(card) : condenseRunCard(card);
  });

const awaitCandidate = (input: AwaitDetailsInput, stage: FitStage): SubagentAwaitDetails => {
  const source = input.runs.slice(0, MAX_TARGET_RUNS);
  const requestedAwaitedRunIds = (input.awaitedRunIds ?? Arr.map(source, (run) => run.id)).slice(
    0,
    MAX_TARGET_RUNS,
  );
  const targetIds = new Set(Arr.map(source, (run) => run.id));
  const contextCandidates = Fn.pipe(
    projectRunCardTree(input.contextRuns ?? []),
    Arr.map((row) => row.run),
    Arr.filter((run) => !targetIds.has(run.id)),
  );
  const contextSource = contextCandidates.slice(0, Math.max(0, MAX_TARGET_RUNS - source.length));
  const targetCards = projectedCards(source, stage);
  const contextCards = projectedCards(contextSource, stage === "reports" ? "report-free" : stage);
  const awaitedRunIds =
    targetCards.length > 0 ? Arr.map(targetCards, (card) => card.id) : requestedAwaitedRunIds;
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
      !Arr.some([...source, ...contextSource], (run) => run.error !== undefined) && {
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
  input: RunDetailsInput,
  stage: FitStage,
): Exclude<CompactSubagentToolDetails, { readonly action: "models" }> => {
  const source = input.runs.slice(0, MAX_TARGET_RUNS);
  const cards = projectedCards(source, stage);
  const failures = projectActionFailures(input.actionFailures);
  const reportsOmitted = stage === "report-free" && reportsWereOmitted(source);
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: input.action,
    cards,
    runCount: input.runs.length,
    ...(failures !== undefined && failures.length > 0 && { actionFailures: failures }),
    ...((reportsOmitted || stage === "condensed") && { contentOmitted: true as const }),
    ...(reportsOmitted &&
      !Arr.some(input.runs, (run) => run.error !== undefined) &&
      !input.actionFailures?.length && { reportsOnlyOmitted: true as const }),
  };
};

const modelDetailsCandidate = (input: ModelDetailsInput, stage: FitStage): ModelDetails => {
  const profiles = projectSubagentProfileRoutes(input.profiles);
  const agents = projectSubagentAgentRoutes(input.agents ?? []);
  const invalidAgents = projectInvalidAgents(input.invalidAgents ?? []);
  const base: ModelDetails = {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "models",
    profiles: stage === "condensed" ? Arr.map(profiles, condenseProfileRoute) : profiles,
    ...(agents.length > 0 && {
      agents: stage === "condensed" ? Arr.map(agents, condenseAgentRoute) : agents,
    }),
    ...(invalidAgents.length > 0 && { invalidAgents }),
    fallbackProfile: input.fallbackProfile,
  };
  return stage === "condensed" ? { ...base, contentOmitted: true as const } : base;
};

export const compactToolDetails = (input: RunDetailsInput): CompactSubagentToolDetails =>
  semanticCandidate(
    REPORT_FREE_STAGES,
    (stage) => runDetailsCandidate(input, stage),
    decodeCompactToolDetails,
  );

/**
 * `agent_profiles` details, condensed when needed. Routes too large even condensed leave no
 * details, so the call keeps its full text with generic presentation instead of failing.
 */
export const modelDetails = (input: ModelDetailsInput): CompactSubagentToolDetails | undefined =>
  fittedCandidate(
    REPORT_FREE_STAGES,
    (stage) => modelDetailsCandidate(input, stage),
    decodeCompactToolDetails,
  );
