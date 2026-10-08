import { ACTIVITY_LIMITS } from "pi-cosmic-ui/activity";
import { countLabel, formatCost, formatTokens, sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { SubagentRunView } from "../run/model.ts";
import type { WorkflowAgentView } from "../workflow/model.ts";
import { workflowEndReasonLine, workflowMemberLine } from "./workflow-activity-detail.ts";

const RECENT_EVENTS = 12;

const bounded = (text: string, maximumLength: number): string =>
  sanitizeDiagnosticContent(text, { maximumLength });

/** A titled section, or nothing when its body is empty. */
const section = (title: string, body: string, maximumLength: number): string =>
  body.trim() ? `${title}:\n${bounded(body, maximumLength)}` : "";

/** Where a run sits in Activity: under its workflow, or as a root run that has its call settled. */
interface RunActivityPlacement {
  /** The member's settled agent() call, while it still describes the run. */
  readonly call?: WorkflowAgentView | undefined;
  /** Whether Activity shows the run under its workflow, whose breadcrumb then names it. */
  readonly nested: boolean;
}

/**
 * A former workflow member's workflow, when Activity no longer shows the run under it, and why
 * its agent() call ended without a result. A reason the run's error already gives is left to
 * the error.
 */
const workflowLines = (run: SubagentRunView, placement: RunActivityPlacement): string => {
  if (run.workflow === undefined) return "";
  const call = placement.call;
  const repeated = call?.reason !== undefined && run.error?.startsWith(call.reason) === true;
  return [
    placement.nested
      ? undefined
      : workflowMemberLine(run.workflow.name ?? run.workflow.workflowId, run.workflow.phase),
    call && !repeated ? workflowEndReasonLine(call) : undefined,
  ]
    .filter(Boolean)
    .join("\n");
};

/** The run's error and warnings, then its report. */
const outcome = (run: SubagentRunView): string =>
  [
    bounded(
      [
        run.error && `Error: ${run.error}`,
        run.warning && `Warning: ${run.warning}`,
        run.systemWarning && `Warning: ${run.systemWarning}`,
      ]
        .filter(Boolean)
        .join("\n"),
      1_000,
    ),
    section("Result", run.finalText ?? "", 6_000),
  ]
    .filter(Boolean)
    .join("\n\n");

const recentActivity = (run: SubagentRunView): string =>
  [
    ...run.sessionEvents
      .slice(-RECENT_EVENTS)
      .map((event) =>
        event.type === "tool"
          ? `${event.toolName}: ${event.state}${event.target ? ` · ${event.target}` : ""}`
          : event.text.slice(-600),
      ),
    ...(run.progress && run.finalText === undefined ? [`Progress: ${run.progress}`] : []),
  ]
    .join("\n")
    .slice(-3_000);

/** What the run used; empty before it used anything. */
const usageLine = (run: SubagentRunView): string =>
  run.usage.totalTokens === 0 && !run.toolUses
    ? ""
    : [
        `Usage: ${formatTokens(run.usage.totalTokens)} tokens (${formatTokens(run.usage.output)} output)`,
        run.usage.cost === undefined ? "" : `~${formatCost(run.usage.cost)}`,
        run.toolUses === undefined ? "" : countLabel(run.toolUses, "tool use"),
      ]
        .filter(Boolean)
        .join(" · ");

/** Identifiers and process facts for diagnosis; last, so the detail's clip drops them first. */
const technical = (run: SubagentRunView): string =>
  [
    `ID: ${run.id} · assignment/report: ${run.reportGeneration} · report: ${run.reportStatus ?? "unknown"}`,
    `Route: ${run.host}/${run.runtime} · ${run.model}`,
    `Cwd: ${run.cwd} · PID: ${run.pid ?? "none"}`,
    `Capabilities: ${run.capabilities.join(", ")} · steering: ${run.steeringDelivery ?? "none"}`,
    `Writes: ${run.writeIntent} · claims: ${run.writeClaims?.join(", ") ?? "exclusive / none"}`,
    `File access paused: ${run.writeAdmissionPaused === true}`,
    `Workspace: ${run.writerWorkspaceMode ?? "shared-checkout"} · ${run.workspaceId ?? "none"}`,
    `Native agents: ${run.nativeActivity?.active ?? 0} active / ${run.nativeActivity?.total ?? 0} total`,
    run.sessionFile ? `Session: ${run.sessionFile}` : "",
  ]
    .filter(Boolean)
    .join("\n");

/**
 * Detail pane text for a run beneath the state, profile and elapsed time Activity already shows,
 * people first: its model, why its workflow call ended without a result, the question it asks,
 * its outcome, task, recent activity and usage, then technical facts. The whole detail is clipped
 * to the protocol's bound, which drops technical facts before anything else.
 */
export const runActivityDetail = (run: SubagentRunView, placement: RunActivityPlacement): string =>
  bounded(
    [
      bounded(
        [`Model: ${run.model}:${run.effort}`, workflowLines(run, placement)].join("\n").trim(),
        1_024,
      ),
      run.question ? `Question for parent: ${bounded(run.question.message, 1_000)}` : "",
      outcome(run),
      section("Task", run.task, 2_000),
      section("Recent activity", recentActivity(run), 3_000),
      bounded(usageLine(run), 512),
      section("Technical", technical(run), 2_000),
    ]
      .filter(Boolean)
      .join("\n\n"),
    ACTIVITY_LIMITS.detail,
  );
