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
  DENSITY_ORDER,
  omitReports,
  projectActionFailures,
  projectFailure,
  projectStartEntry,
  projectSubagentProfileRoutes,
  projectSubagentRunCard,
  type DetailDensity,
} from "./details-projection.ts";
import type { SubagentProfileView } from "./model.ts";

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
        .toSorted((left, right) => left.index - right.index)
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

export const startDetails = (input: StartDetailsInput): SubagentStartDetails =>
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
      input.timedOutSeconds !== undefined && { timedOutSeconds: input.timedOutSeconds }),
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

export const awaitDetails = (input: AwaitDetailsInput): SubagentAwaitDetails =>
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

export const compactToolDetails = (input: CompactToolDetailsInput): CompactSubagentToolDetails => {
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
