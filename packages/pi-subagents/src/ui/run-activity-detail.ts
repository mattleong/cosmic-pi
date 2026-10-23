import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { ACTIVITY_LIMITS } from "pi-cosmic-ui/activity";
import { countLabel, formatCost, formatTokens } from "pi-cosmic-core/display";
import { sanitizeDiagnosticContent } from "pi-cosmic-core/security";
import type { SubagentRunView } from "../run/model.ts";
import {
  cleanupEvidenceText,
  cleanupRecoveryText,
  workspaceOutcomeLabel,
} from "../tools/format.ts";
import { isTextFragment } from "../tools/text-fragments.ts";

const RECENT_EVENTS = 12;

const bounded = (text: string, maximumLength: number): string =>
  sanitizeDiagnosticContent(text, { maximumLength });

const section = (title: string, body: string, maximumLength: number): string =>
  Str.trim(body) ? `${title}:\n${bounded(body, maximumLength)}` : "";

const workspaceOutcome = (run: SubagentRunView): string =>
  run.workspaceOutcome ? Str.capitalize(workspaceOutcomeLabel(run.workspaceOutcome)) : "";

const outcome = (run: SubagentRunView): string =>
  Fn.pipe(
    [
      workspaceOutcome(run),
      bounded(
        Fn.pipe(
          [
            run.error && `Error: ${run.error}`,
            run.warning && `Warning: ${run.warning}`,
            run.systemWarning && `Warning: ${run.systemWarning}`,
          ],
          Arr.filter(isTextFragment),
          Arr.join("\n"),
        ),
        1_000,
      ),
      section("Result", run.finalText ?? "", 6_000),
    ],
    Arr.filter(isTextFragment),
    Arr.join("\n\n"),
  );

const recentActivity = (run: SubagentRunView): string =>
  Fn.pipe(
    [
      ...Arr.map(run.sessionEvents.slice(-RECENT_EVENTS), (event) =>
        event.type === "tool"
          ? Arr.join(
              [
                `${event.toolName}: ${event.state}${event.target ? ` · ${event.target}` : ""}`,
                ...(event.outputPreview === undefined
                  ? []
                  : Arr.map(Str.split(event.outputPreview, "\n"), (line) => `  ${line}`)),
              ],
              "\n",
            )
          : Fn.pipe(event.text, Str.slice(-600)),
      ),
      ...(run.progress && run.finalText === undefined ? [`Progress: ${run.progress}`] : []),
    ],
    Arr.join("\n"),
    Str.slice(-3_000),
  );

const usageLine = (run: SubagentRunView): string =>
  run.usage.totalTokens === 0 && !run.toolUses
    ? ""
    : Fn.pipe(
        [
          `Usage: ${formatTokens(run.usage.totalTokens)} tokens (${formatTokens(run.usage.output)} output)`,
          run.usage.cost === undefined ? "" : `~${formatCost(run.usage.cost)}`,
          run.toolUses === undefined ? "" : countLabel(run.toolUses, "tool use"),
          run.usage.contextPercent === undefined
            ? ""
            : `context ${Math.round(run.usage.contextPercent)}% full`,
        ],
        Arr.filter(Boolean),
        Arr.join(" · "),
      );

const technical = (run: SubagentRunView): string =>
  Fn.pipe(
    [
      `ID: ${run.id} · assignment/report: ${run.reportGeneration} · report: ${run.reportStatus ?? "unknown"}`,
      `Route: local/${run.runtime} · ${run.model}`,
      `Cwd: ${run.cwd} · PID: ${run.pid ?? "none"}`,
      `Capabilities: ${Arr.join(run.capabilities, ", ")} · steering: ${run.steeringDelivery ?? "none"}`,
      `Writes: ${run.writeIntent}`,
      `Workspace: ${run.writerWorkspaceMode ?? "shared-checkout"} · ${run.workspaceId ?? "none"}`,
      `Native agents: ${run.nativeActivity?.active ?? 0} active / ${run.nativeActivity?.total ?? 0} total`,
      run.sessionFile ? `Session: ${run.sessionFile}` : "",
    ],
    Arr.filter(Boolean),
    Arr.join("\n"),
  );

export const runActivityDetail = (run: SubagentRunView): string =>
  bounded(
    Fn.pipe(
      [
        bounded(`Model: ${run.model}:${run.effort}`, 1_024),
        run.question ? `Question for parent: ${bounded(run.question.message, 1_000)}` : "",
        section(
          "Cleanup",
          Arr.join(cleanupRecoveryText(run), "\n") || cleanupEvidenceText(run),
          3_000,
        ),
        outcome(run),
        section("Task", run.task, 2_000),
        section("Recent activity", recentActivity(run), 3_000),
        bounded(usageLine(run), 512),
        section("Technical", technical(run), 2_000),
      ],
      Arr.filter(Boolean),
      Arr.join("\n\n"),
    ),
    ACTIVITY_LIMITS.detail,
  );
