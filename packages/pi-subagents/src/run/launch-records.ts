import * as Effect from "effect/Effect";
import type { BackendLaunchRequest } from "../backend/model.ts";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import { invalidRequest, type SubagentError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import {
  emptyUsage,
  isTerminalRunState,
  type StartSubagentRequest,
  type SubagentCapability,
  type SubagentRunView,
} from "./model.ts";
import { remainingRouteCandidates } from "./retry.ts";
import { MAX_TASK_CHARS } from "./state.ts";
import { childSystemPrompt } from "./tool-policy.ts";
import type { WriterPoolLookup } from "./writer-pool.ts";
import { descendantRunIds } from "./tree.ts";

export interface LaunchPlan {
  readonly request: StartSubagentRequest;
  readonly parentRunId: string;
  readonly cwd: string;
  readonly writeClaims: ReadonlyArray<string> | undefined;
}

export interface LaunchIdentity {
  readonly id: string;
  readonly name: string;
}

export const validateStartRequest = (
  request: StartSubagentRequest,
): Effect.Effect<ReadonlyArray<string> | undefined, SubagentError> =>
  Effect.gen(function* () {
    if (!request.task.trim())
      return yield* invalidRequest("task_required", "Subagent task is required.");
    if (request.task.length > MAX_TASK_CHARS)
      return yield* invalidRequest(
        "task_too_large",
        `Subagent task is too large: ${request.task.length.toLocaleString("en-US")} characters, over the ${MAX_TASK_CHARS.toLocaleString("en-US")}-character limit.`,
      );
    const normalizedClaims =
      request.writes === undefined ? undefined : normalizeWriteClaims(request.writes);
    if (normalizedClaims && !normalizedClaims.ok)
      return yield* invalidRequest(normalizedClaims.code, normalizedClaims.message);
    if (normalizedClaims && request.writeIntent !== "writer")
      return yield* invalidRequest(
        "write_claims_read_only",
        "writes may be supplied only for a writer subagent.",
      );
    if (!request.closeOnReport)
      return yield* invalidRequest(
        "retained_report_capability_invalid",
        "closeOnReport=false is unsupported; local subagents close after reporting.",
      );
    return normalizedClaims?.claims;
  });

export const withWriteClaims = (
  base: StartSubagentRequest,
  writeClaims: ReadonlyArray<string> | undefined,
): StartSubagentRequest => (writeClaims === undefined ? base : { ...base, writes: writeClaims });

export const initialRunView = (
  { request, parentRunId, cwd, writeClaims }: LaunchPlan,
  parent: RunRecord | undefined,
  { id, name }: LaunchIdentity,
  capabilities: ReadonlyArray<SubagentCapability>,
  now: number,
): SubagentRunView => ({
  id,
  name,
  task: request.task.trim(),
  ...(request.profile && { profile: request.profile }),
  ...(request.supersedes && { predecessorRunId: request.supersedes.runId }),
  ...(request.routeContinuation && {
    remainingCandidateCount: remainingRouteCandidates(request.routeContinuation),
  }),
  parentRunId,
  depth: (parent?.view.depth ?? 0) + 1,
  selection: request.selection ?? {
    source: "profile-candidate",
    reason: "Profile route selection.",
    skippedCandidates: [],
  },
  cwd,
  ...(request.writerWorkspaceMode && {
    writerWorkspaceMode: request.writerWorkspaceMode,
  }),
  ...(request.workspace && {
    workspaceId: request.workspace.workspaceId,
    sourceCwd: request.workspace.sourceCwd,
  }),
  state: "starting",
  context: request.context,
  writeIntent: request.writeIntent,
  ...(writeClaims !== undefined && {
    writeClaims,
    writeAudit: {
      observedFileWrites: [],
      violations: [],
      bashWriteHints: 0,
    },
  }),
  openaiFastMode: request.openaiFastMode,
  host: request.host,
  runtime: request.runtime,
  closeOnReport: request.closeOnReport,
  reportGeneration: 0,
  assignmentEpoch: 1,
  capabilities,
  model: request.model,
  effort: request.effort,
  startedAt: now,
  lastActivityAt: now,
  sessionEvents: [],
  usage: emptyUsage(),
});

export const backendLaunchRequest = (
  { request, cwd, writeClaims }: LaunchPlan,
  { id, name }: LaunchIdentity,
): BackendLaunchRequest => ({
  runId: id,
  name,
  cwd,
  context: request.context,
  writeIntent: request.writeIntent,
  openaiFastMode: request.openaiFastMode,
  model: request.model,
  effort: request.effort,
  ...(request.runtimeApiKey && { runtimeApiKey: request.runtimeApiKey }),
  activeTools: request.activeTools,
  projectTrusted: request.projectTrusted,
  parentSessionId: request.parentSessionId,
  ...(request.parentSessionFile && { parentSessionFile: request.parentSessionFile }),
  ...(request.parentLeafId && { parentLeafId: request.parentLeafId }),
  ...(request.sharesParentPromptCache && { sharesParentPromptCache: true }),
  systemPrompt: childSystemPrompt(withWriteClaims(request, writeClaims)),
});

export const isEvictionEligible = (
  {
    records,
    writerPools,
  }: Pick<RunContext, "records"> & { readonly writerPools: WriterPoolLookup },
  record: RunRecord,
): boolean =>
  !record.cleanupPending &&
  record.process === undefined &&
  descendantRunIds(records, record.view.id).length === 0 &&
  writerPools.get(record.canonicalWriterCwd?.digest ?? "")?.violationRunIds.has(record.view.id) !==
    true &&
  record.retryClaim === undefined &&
  record.completionClaims.size === 0 &&
  record.completionGenerations.size === 0 &&
  isTerminalRunState(record.view.state);
