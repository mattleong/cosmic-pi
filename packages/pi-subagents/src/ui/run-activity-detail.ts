import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type {
  ActivityDetail,
  ActivityDetailField,
  ActivityDetailSection,
} from "pi-cosmic-ui/activity";
import { countLabel, formatCost, formatTokens } from "pi-cosmic-core/display";
import { SUITE_STATUS_GLYPHS } from "pi-cosmic-ui/manager";
import { sanitizeDiagnosticContent } from "pi-cosmic-core/security";
import type { SubagentRunView, SubagentSessionEvent } from "../run/model.ts";
import { userRunText } from "../run/warnings.ts";
import {
  cleanupEvidenceText,
  cleanupRecoveryText,
  workspaceOutcomeLabel,
} from "../tools/format.ts";
import { isCoordinationTool, SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { type RunNameLookup, type ToolEvent, waitingOn } from "./run-live-activity.ts";
import { isTextFragment } from "../tools/text-fragments.ts";
import { WRITER_WORKSPACE_LABELS } from "./run-facts.ts";
import { homeDisplayPath } from "./display-path.ts";

const RECENT_EVENTS = 12;

const bounded = (text: string, maximumLength: number): string =>
  sanitizeDiagnosticContent(text, { maximumLength });

const section = (
  title: string | undefined,
  body: string,
  maximumLength: number,
  format?: "markdown",
  expandedBody?: string,
): ActivityDetailSection[] =>
  Str.isNonEmpty(Str.trim(body))
    ? [
        {
          ...(title && { title }),
          body: bounded(body, maximumLength),
          ...(expandedBody !== undefined &&
            expandedBody !== body && { expandedBody: bounded(expandedBody, maximumLength) }),
          ...(format && { format }),
        },
      ]
    : [];

const firstLine = (text: string): string => Str.trim(Str.split(Str.trim(text), "\n")[0] ?? "");

// The error's first line says what happened; any trace behind it is technical detail.
const problems = (run: SubagentRunView): ActivityDetailSection[] => {
  const shown = userRunText(run);
  const warnings = Arr.dedupe(Arr.filter([shown.warning, shown.systemWarning], isTextFragment));
  return [
    ...section("Error", firstLine(shown.error ?? ""), 1_000),
    ...section(warnings.length > 1 ? "Warnings" : "Warning", Arr.join(warnings, "\n"), 1_000),
  ];
};

// A finished call leads with the glyph that says how it ended. Details don't redraw, so a call
// still running is marked neutral and keeps its word, as snapshot rows do.
const TOOL_EVENT_GLYPHS = {
  completed: SUITE_STATUS_GLYPHS.succeeded,
  failed: SUITE_STATUS_GLYPHS.failed,
  running: SUITE_STATUS_GLYPHS.neutral,
} as const satisfies Record<ToolEvent["state"], string>;

interface ToolLines {
  /** The call as one line: its state's glyph, tool, target, and outcome. */
  readonly line: string;
  /** The call's output as printed, indented beneath it, for an inspected item. */
  readonly output: readonly string[];
}

/**
 * A tool call as one line: its state's glyph, then an owned agent tool's phrased result, or
 * another tool's target, with its output as printed kept apart for an inspected item. Agent
 * tools' model-facing envelopes never reach this view.
 */
const toolLines = (event: ToolEvent, nameOf: RunNameLookup): ToolLines => {
  const { activity } = event;
  const outcome = activity
    ? [activity.summary]
    : event.state === "running"
      ? [event.toolName === SUBAGENT_TOOL_NAME.await ? waitingOn(event, nameOf) : "running"]
      : [];
  return {
    line: `${TOOL_EVENT_GLYPHS[event.state]} ${Arr.join(
      Arr.filter([event.toolName, event.target, ...outcome], isTextFragment),
      " · ",
    )}`,
    output:
      activity || event.outputPreview === undefined || isCoordinationTool(event.toolName)
        ? []
        : Arr.map(Str.split(event.outputPreview, "\n"), (line) => `  ${line}`),
  };
};

// The final report is shown once, as the Result, so recent activity leaves it out.
const isFinalReport = (run: SubagentRunView, event: SubagentSessionEvent): boolean =>
  event.type === "assistant" &&
  run.finalText !== undefined &&
  Str.trim(event.text) === Str.trim(run.finalText);

/**
 * Recent events in order: tool calls and notices stay verbatim, while the agent's own messages and
 * the words its agent tools returned render as Markdown, the way the transcript shows them. A
 * preview lists each tool call on one line; an inspected item shows each call's output beneath it.
 */
const recentActivity = (run: SubagentRunView, nameOf: RunNameLookup): ActivityDetailSection[] => {
  const events = Arr.filter(
    run.sessionEvents.slice(-RECENT_EVENTS),
    (event) => !isFinalReport(run, event),
  );
  const groups: Array<{ markdown: boolean; lines: string[]; expanded: string[] }> = [];
  const push = (markdown: boolean, text: string, output: readonly string[] = []) => {
    const last = groups.at(-1);
    if (last && !markdown && !last.markdown) {
      last.lines.push(text);
      last.expanded.push(text, ...output);
    } else groups.push({ markdown, lines: [text], expanded: [text, ...output] });
  };
  for (const event of events) {
    if (event.type === "tool") {
      const { line, output } = toolLines(event, nameOf);
      push(false, line, output);
      // The words an agent tool returned, such as a report or reply, read as the agent wrote them.
      if (event.activity?.text) push(true, event.activity.text);
    } else if (event.type === "assistant") push(true, Fn.pipe(event.text, Str.slice(-600)));
    else push(false, Fn.pipe(event.text, Str.slice(-600)));
  }
  if (run.progress && run.finalText === undefined) push(false, `Progress: ${run.progress}`);
  return Arr.flatMap(groups, (group, index) =>
    section(
      index === 0 ? "Recent activity" : undefined,
      Arr.join(group.lines, "\n"),
      3_000,
      group.markdown ? "markdown" : undefined,
      Arr.join(group.expanded, "\n"),
    ),
  );
};

// The model leads the row's status line, so usage starts with what the run consumed.
const usageLine = (run: SubagentRunView): string =>
  Fn.pipe(
    [
      run.usage.totalTokens === 0
        ? ""
        : `${formatTokens(run.usage.totalTokens)} tokens (${formatTokens(run.usage.output)} output)`,
      run.usage.cost === undefined || run.usage.totalTokens === 0
        ? ""
        : `~${formatCost(run.usage.cost)}`,
      run.toolUses === undefined ? "" : countLabel(run.toolUses, "tool use"),
      run.usage.contextPercent === undefined
        ? ""
        : `context ${Math.round(run.usage.contextPercent)}% full`,
    ],
    Arr.filter(Str.isNonEmpty),
    Arr.join(" · "),
  );

const REPORT_STATUS = {
  available: "ready for the parent",
  claimed: "being delivered",
  delivered: "delivered to the parent",
  missing: "missing",
} as const satisfies Record<NonNullable<SubagentRunView["reportStatus"]>, string>;

const MAX_AGENT_TOOL_FACTS = 8;

// IDs, routes, and report files behind the agent tools' phrased results, newest last.
const agentToolFacts = (run: SubagentRunView): ActivityDetailField[] =>
  Fn.pipe(
    run.sessionEvents.slice(-RECENT_EVENTS),
    Arr.flatMap((event) => (event.type === "tool" ? (event.activity?.facts ?? []) : [])),
    Arr.dedupeWith((left, right) => left.label === right.label && left.value === right.value),
    (facts) => facts.slice(-MAX_AGENT_TOOL_FACTS),
  );

// The Activity row carries the route, override marker included, so it is left to the shell.
const technical = (run: SubagentRunView): ActivityDetailField[] =>
  Arr.filter(
    [
      { label: "ID", value: run.id },
      // A first assignment is the only one; later ones say which they are, as run cards do.
      { label: "Assignment", value: run.reportGeneration > 1 ? String(run.reportGeneration) : "" },
      { label: "Report", value: run.reportStatus ? REPORT_STATUS[run.reportStatus] : "" },
      { label: "Directory", value: homeDisplayPath(run.cwd) },
      { label: "PID", value: run.pid === undefined ? "none" : String(run.pid) },
      { label: "Writes", value: run.writeIntent },
      {
        label: "Workspace",
        value: `${WRITER_WORKSPACE_LABELS[run.writerWorkspaceMode ?? "shared-checkout"]}${run.workspaceId ? ` · ${run.workspaceId}` : ""}`,
      },
      { label: "Session", value: run.sessionFile ? homeDisplayPath(run.sessionFile) : "" },
      {
        label: "Error detail",
        value:
          run.error !== undefined && Str.trim(run.error) !== firstLine(run.error) ? run.error : "",
      },
    ],
    (field) => Str.isNonEmpty(field.value),
  );

/** Leads with what needs the user or what the run produced; identity sits behind Technical. */
export const runActivityDetail = (
  run: SubagentRunView,
  nameOf: RunNameLookup = () => undefined,
): ActivityDetail => ({
  sections: [
    ...section("Question for parent", run.question?.message ?? "", 1_000),
    ...problems(run),
    ...section(
      undefined,
      run.workspaceOutcome ? Str.capitalize(workspaceOutcomeLabel(run.workspaceOutcome)) : "",
      512,
    ),
    ...section("Result", run.finalText ?? "", 6_000, "markdown"),
    ...section(
      "Cleanup",
      Arr.join(cleanupRecoveryText(run), "\n") || cleanupEvidenceText(run),
      3_000,
    ),
    ...section("Task", run.task, 2_000),
    ...recentActivity(run, nameOf),
    ...section(undefined, usageLine(run), 512),
  ],
  technical: Arr.map([...technical(run), ...agentToolFacts(run)], (field) => ({
    label: field.label,
    value: bounded(field.value, 1_024),
  })),
});
