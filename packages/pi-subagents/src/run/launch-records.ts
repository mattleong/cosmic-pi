import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import type { BackendLaunchRequest } from "../backend/model.ts";
import { invalidRequest, type SubagentError, withGuidance } from "./errors.ts";
import { isCleanupOwed, type RunRecord, type StoredRunView } from "./internal.ts";
import {
  emptyUsage,
  isTerminalRunState,
  nextRouteCandidate,
  type StartSubagentRequest,
} from "./model.ts";
import { MAX_TASK_CHARS } from "./state.ts";
import { childSystemPrompt } from "./tool-policy.ts";
import { descendantRunIds } from "./tree.ts";
import { formatCount } from "pi-cosmic-core/display";

export interface LaunchPlan {
  readonly request: StartSubagentRequest;
  readonly parentRunId: string;
  readonly cwd: string;
}

interface LaunchIdentity {
  readonly id: string;
  readonly name: string;
}

export const scriptOriginForStart = (
  records: ReadonlyMap<string, RunRecord>,
  request: StartSubagentRequest,
  scriptedRoot: boolean,
): boolean =>
  scriptedRoot ||
  (request.parentRunId !== undefined && records.get(request.parentRunId)?.scriptOrigin === true);

export const scriptedWriterAdmissionError = () =>
  invalidRequest(
    "scripted_subtree_writer_not_supported",
    withGuidance(
      "Agents started by a codemode script can only launch read-only agents",
      "The main agent can start separate writer work outside this script's agents.",
      "\n\n",
    ),
  );

export const validateStartRequest = (
  request: StartSubagentRequest,
): Effect.Effect<void, SubagentError> => {
  if (!Str.trim(request.task))
    return Effect.fail(invalidRequest("task_required", "Subagent task is required."));
  if (request.task.length > MAX_TASK_CHARS)
    return Effect.fail(
      invalidRequest(
        "task_too_large",
        `Subagent task is too large: ${formatCount(request.task.length)} characters, over the ${formatCount(MAX_TASK_CHARS)}-character limit.`,
      ),
    );
  return Effect.void;
};

export const initialRunView = (
  { request, parentRunId, cwd }: LaunchPlan,
  parent: RunRecord | undefined,
  id: string,
  now: number,
): StoredRunView => ({
  id,
  task: Str.trim(request.task),
  ...(request.profile && { profile: request.profile }),
  ...(request.agent && { agent: request.agent }),
  ...(request.routeContinuation && {
    nextCandidate: nextRouteCandidate(request.routeContinuation),
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
  reportGeneration: 0,
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
  systemPrompt: childSystemPrompt(request),
});

export const isEvictionEligible = (
  records: ReadonlyMap<string, RunRecord>,
  record: RunRecord,
): boolean =>
  !isCleanupOwed(record) &&
  record.process === undefined &&
  descendantRunIds(records, record.view.id).length === 0 &&
  record.completionClaims.size === 0 &&
  record.completionGenerations.size === 0 &&
  isTerminalRunState(record.view.state);
