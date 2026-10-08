/** Explicit projections of authoritative workflow observations; never renderer-limited views. */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { sanitizeDiagnosticContent, stripTerminalControls } from "pi-cosmic-core";
import type { WorkflowAgentAttention } from "../workflow/attention.ts";
import {
  countWorkflowRunAgents,
  workflowAgentTotal,
  workflowWorkspaces,
  type WorkflowLogEntry,
  type WorkflowRunView,
  type WorkflowSource,
} from "../workflow/model.ts";
import type { WorkflowRecordedRun } from "../workflow/run-record.ts";
import type { WorkflowPhase } from "../workflow/script.ts";
import type { WorkflowToolStatus } from "../workflow/service.ts";
import type { WorkflowListing } from "../workflow/store.ts";
import {
  encodeWorkflowContract,
  WORKFLOW_CONTRACT_ID,
  type WorkflowContract,
  type WorkflowLiveContract,
  type WorkflowStartContract,
  type WorkflowStatusContract,
  type WorkflowStopContract,
  type WorkflowListContract,
} from "./workflow-contract-schema.ts";
import { WORKFLOW_TOOL_NAME, type WorkflowToolDetails } from "./workflow-schema.ts";

const envelope = { contract: WORKFLOW_CONTRACT_ID, version: 1, tool: WORKFLOW_TOOL_NAME } as const;
/** Redact diagnostic secrets/terminal controls without clipping recovery evidence. */
const diagnostic = (value: string): string =>
  sanitizeDiagnosticContent(stripTerminalControls(value), {
    maximumLength: Number.MAX_SAFE_INTEGER,
  });
const source = (value: WorkflowSource): WorkflowSource => {
  switch (value.kind) {
    case "inline":
      return { kind: "inline" };
    case "file":
      return { kind: "file", path: value.path };
    case "saved":
      return { kind: "saved", name: value.name, scope: value.scope, path: value.path };
  }
};
const phase = (value: WorkflowPhase) => ({
  title: value.title,
  ...(value.detail !== undefined && { detail: diagnostic(value.detail) }),
  ...(value.agents !== undefined && {
    agents: value.agents.map((entry) =>
      Predicate.isString(entry)
        ? entry
        : {
            label: entry.label,
            ...(entry.profile !== undefined && { profile: entry.profile }),
          },
    ),
  }),
});
const log = (entry: WorkflowLogEntry) => ({
  at: entry.at,
  level: entry.level,
  message: diagnostic(entry.message),
});
const reference = (run: WorkflowRunView) => ({
  id: run.id,
  name: run.name,
  state: run.state,
  startedAt: run.startedAt,
  source: source(run.source),
  ...(run.scriptPath !== undefined && { scriptPath: run.scriptPath }),
  ...(run.resumedFrom !== undefined && { resumedFrom: run.resumedFrom }),
});
const receipt = (run: WorkflowRunView): WorkflowStartContract["run"] => ({
  ...reference(run),
  ...(run.budget !== undefined && {
    budget: { total: run.budget.total, spent: run.budget.spent, refused: run.budget.refused },
  }),
  ...(run.warnings !== undefined && { warnings: run.warnings.map(log) }),
});
const live = (run: WorkflowRunView): WorkflowLiveContract => ({
  ...receipt(run),
  description: diagnostic(run.description),
  ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
  phases: run.phases.map(phase),
  ...(run.currentPhase !== undefined && { currentPhase: run.currentPhase }),
  agents: run.agents.map((agent) => ({
    callId: agent.callId,
    runId: agent.runId,
    label: agent.label,
    state: agent.state,
    queuedAt: agent.queuedAt,
    ...(agent.phase !== undefined && { phase: agent.phase }),
    ...(agent.profile !== undefined && { profile: agent.profile }),
    ...(agent.startedAt !== undefined && { startedAt: agent.startedAt }),
    ...(agent.endedAt !== undefined && { endedAt: agent.endedAt }),
    ...(agent.workspaceId !== undefined && { workspaceId: agent.workspaceId }),
    ...(agent.unchanged !== undefined && { unchanged: agent.unchanged }),
    ...(agent.reason !== undefined && { reason: diagnostic(agent.reason) }),
    ...(agent.waiting !== undefined && {
      waiting:
        agent.waiting.kind === "slot"
          ? { kind: "slot" as const }
          : {
              kind: "writer" as const,
              runId: agent.waiting.runId,
              name: agent.waiting.name,
              paused: agent.waiting.paused,
            },
    }),
  })),
  planned: run.planned.map((entry) => ({
    runId: entry.runId,
    phase: entry.phase,
    label: entry.label,
    ...(entry.profile !== undefined && { profile: entry.profile }),
    ...(entry.workflow !== undefined && { workflow: entry.workflow }),
    ...(entry.skippedAt !== undefined && { skippedAt: entry.skippedAt }),
  })),
  reused: run.reused,
  ...(run.reusedPhases !== undefined && {
    reusedPhases: run.reusedPhases.map((entry) => ({ title: entry.title, count: entry.count })),
  }),
  ...(run.reusedWorkspaces !== undefined && {
    reusedWorkspaces: run.reusedWorkspaces.map((entry) => ({
      workspaceId: entry.workspaceId,
      label: entry.label,
    })),
  }),
  workspaces: workflowWorkspaces(run).map((entry) => ({
    workspaceId: entry.workspaceId,
    label: entry.label,
    state: entry.state,
  })),
  ...(run.stoppedBy !== undefined && { stoppedBy: run.stoppedBy }),
  logs: run.logs.map(log),
  ...(run.lastLog !== undefined && { lastLog: diagnostic(run.lastLog) }),
  ...(run.warningCount !== undefined && { warningCount: run.warningCount }),
  usage: {
    input: run.usage.input,
    output: run.usage.output,
    cacheRead: run.usage.cacheRead,
    cacheWrite: run.usage.cacheWrite,
    totalTokens: run.usage.totalTokens,
    toolUses: run.usage.toolUses,
    unpriced: run.usage.unpriced,
    ...(run.usage.cost !== undefined && { cost: run.usage.cost }),
  },
  ...(run.journalPath !== undefined && { journalPath: run.journalPath }),
  ...(run.result !== undefined && {
    result: {
      text: run.result.text,
      clipped: run.result.clipped,
      ...(run.result.path !== undefined && { path: run.result.path }),
    },
  }),
  ...(run.failure !== undefined && {
    failure: {
      message: diagnostic(run.failure.message),
      ...(run.failure.kind !== undefined && { kind: run.failure.kind }),
      ...(run.failure.name !== undefined && { name: diagnostic(run.failure.name) }),
      ...(run.failure.stack !== undefined && { stack: diagnostic(run.failure.stack) }),
    },
  }),
});
const recorded = (run: WorkflowRecordedRun) => ({
  id: run.id,
  name: run.name,
  source: source(run.source),
  state: run.state,
  startedAt: run.startedAt,
  finished: run.finished,
  ...(run.scriptPath !== undefined && { scriptPath: run.scriptPath }),
  ...(run.runningIn !== undefined && { runningIn: run.runningIn }),
  ...(run.stoppedBy !== undefined && { stoppedBy: run.stoppedBy }),
  ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
  ...(run.journalPath !== undefined && { journalPath: run.journalPath }),
});
const attention = (entry: WorkflowAgentAttention) => {
  const base = { runId: entry.runId, writer: entry.writer };
  switch (entry.kind) {
    case "paused":
      return { ...base, kind: entry.kind, canResume: entry.canResume };
    case "question":
      return { ...base, kind: entry.kind, message: diagnostic(entry.message) };
    default:
      return { ...base, kind: entry.kind };
  }
};
export const workflowStartContract = (run: WorkflowRunView): WorkflowStartContract => ({
  ...envelope,
  action: "start",
  run: receipt(run),
});
export const workflowStatusContract = (status: WorkflowToolStatus): WorkflowStatusContract => {
  const base = { ...envelope, action: "status" } as const;
  switch (status.kind) {
    case "recorded":
      return { ...base, kind: status.kind, run: recorded(status.run) };
    // The service produces unchanged only when attention is empty; keep its full current view.
    case "unchanged":
      return {
        ...base,
        kind: status.kind,
        run: live(status.run),
        sinceMs: status.sinceMs,
        attention: [],
      };
    case "view":
      return {
        ...base,
        kind: status.kind,
        run: live(status.run),
        attention: status.attention.map(attention),
      };
  }
};
export const workflowStopContract = (run: WorkflowRunView): WorkflowStopContract => ({
  ...envelope,
  action: "stop",
  run: live(run),
});
export const workflowListContract = (
  listing: WorkflowListing,
  runs: ReadonlyArray<WorkflowRunView>,
): WorkflowListContract => ({
  ...envelope,
  action: "list",
  saved: {
    workflows: listing.workflows.map((entry) => ({
      name: entry.name,
      scope: entry.scope,
      path: entry.path,
      meta: {
        name: entry.meta.name,
        description: diagnostic(entry.meta.description),
        ...(entry.meta.whenToUse !== undefined && { whenToUse: diagnostic(entry.meta.whenToUse) }),
        ...(entry.meta.phases !== undefined && { phases: entry.meta.phases.map(phase) }),
        ...(entry.meta.args !== undefined && { args: entry.meta.args }),
      },
    })),
    diagnostics: listing.diagnostics.map((entry) => ({
      path: entry.path,
      message: diagnostic(entry.message),
    })),
    truncated: listing.truncated,
    locations: {
      project: listing.locations.project,
      projectTrusted: listing.locations.projectTrusted,
      user: listing.locations.user,
    },
  },
  runs: runs.map((run) => ({
    ...reference(run),
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    ...(run.journalPath !== undefined && { journalPath: run.journalPath }),
    ...(run.stoppedBy !== undefined && { stoppedBy: run.stoppedBy }),
    counts: countWorkflowRunAgents(run),
    planned: run.planned.length,
    reused: run.reused,
    total: workflowAgentTotal(run),
  })),
});

const ENCODING_UNCERTAINTY =
  "Structured workflow result unavailable. The action may have taken effect; inspect the retained receipt before deciding what to do next.";

/** An encoding invariant can fail after start/stop acted: preserve its receipt, never imply rollback. */
export const withWorkflowContract = (
  result: AgentToolResult<WorkflowToolDetails>,
  project: () => WorkflowContract,
): AgentToolResult<WorkflowToolDetails> => {
  try {
    return { ...result, structuredContent: encodeWorkflowContract(project()) };
  } catch {
    return {
      ...result,
      isError: true,
      details: {
        ...result.details,
        issue: result.details.issue ?? {
          code: "workflow-contract-unavailable",
          message: "Structured workflow result unavailable",
          detail: ENCODING_UNCERTAINTY,
        },
      },
      content: [...result.content, { type: "text", text: ENCODING_UNCERTAINTY }],
    };
  }
};
