import * as Effect from "effect/Effect";
import type { BackendLaunchRequest } from "../backend/model.ts";
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
import { childSystemPrompt, isWorkspaceParentRequest } from "./tool-policy.ts";
import { descendantRunIds } from "./tree.ts";

export interface LaunchPlan {
  readonly request: StartSubagentRequest;
  readonly parentRunId: string;
  readonly cwd: string;
}

interface LaunchIdentity {
  readonly id: string;
  readonly name: string;
}

export const validateStartRequest = (
  request: StartSubagentRequest,
): Effect.Effect<void, SubagentError> => {
  if (!request.task.trim())
    return Effect.fail(invalidRequest("task_required", "Subagent task is required."));
  if (request.task.length > MAX_TASK_CHARS)
    return Effect.fail(
      invalidRequest(
        "task_too_large",
        `Subagent task is too large: ${request.task.length.toLocaleString("en-US")} characters, over the ${MAX_TASK_CHARS.toLocaleString("en-US")}-character limit.`,
      ),
    );
  return Effect.void;
};

export const initialRunView = (
  { request, parentRunId, cwd }: LaunchPlan,
  parent: RunRecord | undefined,
  { id, name }: LaunchIdentity,
  capabilities: ReadonlyArray<SubagentCapability>,
  now: number,
): SubagentRunView => ({
  id,
  name,
  task: request.task.trim(),
  ...(request.profile && { profile: request.profile }),
  ...(request.agent && { agent: request.agent }),
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
  ...(request.modelOverride && { modelOverride: request.modelOverride }),
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
  openaiFastMode: request.openaiFastMode,
  runtime: request.runtime,
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
  { request, cwd }: LaunchPlan,
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
  ...(isWorkspaceParentRequest(request) && { workspaceParent: true }),
  systemPrompt: childSystemPrompt(request),
});

export const isEvictionEligible = (
  { records }: Pick<RunContext, "records">,
  record: RunRecord,
): boolean =>
  !record.cleanupPending &&
  record.process === undefined &&
  descendantRunIds(records, record.view.id).length === 0 &&
  record.retryClaim === undefined &&
  record.completionClaims.size === 0 &&
  record.completionGenerations.size === 0 &&
  isTerminalRunState(record.view.state);
