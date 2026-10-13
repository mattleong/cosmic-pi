import { ACTIVITY_LIMITS } from "pi-cosmic-ui/activity";
import { countLabel, formatCost, formatTokens, sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { SubagentRunView } from "../run/model.ts";

const RECENT_EVENTS = 12;

const bounded = (text: string, maximumLength: number): string =>
  sanitizeDiagnosticContent(text, { maximumLength });

const section = (title: string, body: string, maximumLength: number): string =>
  body.trim() ? `${title}:\n${bounded(body, maximumLength)}` : "";

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

export const runActivityDetail = (run: SubagentRunView): string =>
  bounded(
    [
      bounded(`Model: ${run.model}:${run.effort}`, 1_024),
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
