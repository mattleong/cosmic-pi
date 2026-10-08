import {
  highlightCode,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Option from "effect/Option";
import type { Static } from "typebox";
import {
  expandedSection,
  getTextContent,
  type CompactIssue,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import {
  clipText,
  countLabel,
  failureMessage,
  formatTokens,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
} from "pi-cosmic-ui/tool";
import { workflowStateLabel } from "../ui/run-state.ts";
import {
  decodeWorkflowToolDetails,
  type WorkflowRunSummary,
  type WorkflowToolDetails,
  type WorkflowToolParameters,
  workflowToolAction,
} from "./workflow-schema.ts";

export type WorkflowToolArgs = Static<typeof WorkflowToolParameters>;

/** Shared by the call and result renderers: the result names the run a status call is about. */
export interface WorkflowRenderState {
  workflowName?: string;
}

/** The parts of Pi's render context these renderers read. */
interface WorkflowRenderContext {
  readonly state: WorkflowRenderState;
  readonly expanded: boolean;
  readonly isPartial: boolean;
  readonly executionStarted: boolean;
}

const TITLE = "Workflow";
/** How a status repeated while nothing changed reads in the row and the digest. */
const UNCHANGED = "unchanged since the last check";
const PREVIEW_LINES = 8;
const META_NAME = /\bname\s*:\s*(["'`])([^"'`\n]{1,80})\1/u;

const detailsOf = (result: AgentToolResult<unknown> | undefined) =>
  Option.getOrUndefined(decodeWorkflowToolDetails(result?.details));

const baseName = (path: string): string => path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;

/** A human subject from the arguments alone; a run id is never a subject. */
const callSubject = (args: Partial<WorkflowToolArgs>): string => {
  const action = workflowToolAction(args);
  if (action === "list") return "saved workflows and runs";
  if (action !== "start") return "";
  if (args.name) return args.name;
  if (args.scriptPath) return baseName(args.scriptPath);
  return args.script?.match(META_NAME)?.[2] ?? "inline script";
};

const subjectOf = (args: Partial<WorkflowToolArgs>, name: string | undefined) =>
  sanitizeTerminalLine(name ?? callSubject(args));

/** Agents by state, in the order and words the workflow's notification row uses. */
const agentStateParts = (run: WorkflowRunSummary): ReadonlyArray<string> =>
  [
    run.running ? `${run.running} running` : "",
    run.queued ? `${run.queued} queued` : "",
    run.failed ? `${run.failed} failed` : "",
    run.stopped ? `${run.stopped} stopped` : "",
    run.skipped ? `${run.skipped} skipped` : "",
  ].filter(Boolean);

/** A list's saved workflows and this session's runs, as the row and the digest count them. */
const listCounter = (details: WorkflowToolDetails): string =>
  `${countLabel(details.saved ?? 0, "saved workflow")} · ${countLabel(details.runs ?? 0, "run")}`;

/** Counter alternatives, longest first: the row shows the first that fits. */
const runCounters = (run: WorkflowRunSummary): ReadonlyArray<string> => {
  const state = workflowStateLabel(run.state);
  const agents = countLabel(run.agents, "agent");
  return [[state, agents, ...agentStateParts(run)].join(" · "), `${state} · ${agents}`, state];
};

/**
 * Why a run failed, for people. A spent budget names its counts; the budget error's agent-facing
 * text waits in the detail.
 */
const failureIssue = (run: WorkflowRunSummary): CompactIssue => {
  const name = sanitizeTerminalLine(run.name);
  return run.budgetFailure
    ? {
        severity: "warning",
        code: "workflow-budget-spent",
        message: `${name} failed: token budget spent (${formatTokens(run.budgetFailure.spent)} of ${formatTokens(run.budgetFailure.total)} output tokens)`,
        ...(run.failure && { detail: run.failure }),
      }
    : {
        severity: "warning",
        code: "workflow-failed",
        message: `${name} failed: ${clipText(failureMessage(run.failure ?? "", "no error message"), 80)}`,
      };
};

const settledRun = (
  base: CompactSummary,
  details: WorkflowToolDetails,
  run: WorkflowRunSummary,
): CompactSummary => {
  if (details.action === "start")
    return {
      ...base,
      ...(run.phases > 0 && { counters: [countLabel(run.phases, "phase")] }),
      outcome: "success",
    };
  // A repeated status with nothing new says so instead of repeating the counts.
  if (details.unchanged === true) {
    const state = workflowStateLabel(run.state);
    return {
      ...base,
      counters: [`${state} · ${UNCHANGED}`, `${state} · unchanged`, state],
      outcome: "returned",
    };
  }
  const failed = run.state === "failed";
  return {
    ...base,
    counters: runCounters(run),
    outcome: details.action === "stop" ? "success" : failed ? "warning" : "returned",
    ...(failed && { issues: [failureIssue(run)] }),
  };
};

/** One semantic row per call; problems arrive as typed issues in the details. */
export const workflowCompactSummary: CompactSummaryProvider<
  WorkflowToolArgs,
  unknown,
  WorkflowRenderState
> = ({ phase, args, result }) => {
  const details = detailsOf(result);
  const action = workflowToolAction(args);
  const base: CompactSummary = {
    subject: subjectOf(args, details?.run?.name),
    ...(action !== undefined && { action }),
  };
  if (phase !== "settled") return base;
  if (!details) return undefined;
  if (details.issue)
    return {
      ...base,
      outcome: "error",
      issues: [
        {
          severity: "error",
          code: details.issue.code,
          message: details.issue.message,
          ...(details.issue.detail !== undefined && { detail: details.issue.detail }),
        },
      ],
    };
  if (details.run) return settledRun(base, details, details.run);
  return {
    ...base,
    counters: [listCounter(details), countLabel(details.saved ?? 0, "saved workflow")],
    outcome: "returned",
  };
};

const scriptLines = (script: string): ReadonlyArray<string> => {
  // Script strings can carry terminal sequences copied from files; never pass them through.
  const source = stripTerminalControls(script);
  try {
    return highlightCode(source, "javascript");
  } catch {
    // Pi's highlighter needs an initialized theme; plain text keeps the source readable.
    return source.split("\n");
  }
};

const scriptComponent = (script: string, theme: Theme, expanded: boolean): Component => {
  const lines = scriptLines(script);
  const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  return new Text(
    [
      ...shown,
      ...(hidden > 0
        ? [renderExpansionAffordance(`${countLabel(hidden, "more line")} of script`, false, theme)]
        : []),
    ].join("\n"),
    0,
    0,
  );
};

/** Preview style: the heading plus a bounded script preview, full once expanded. */
export const renderWorkflowCall = (
  args: Partial<WorkflowToolArgs>,
  theme: Theme,
  context: WorkflowRenderContext,
): Component => {
  const container = new Container();
  // Drawn lazily: the result, rendered after the call, names the run a status call is about.
  container.addChild(
    composeToolComponent((width) => {
      const subtitle = [workflowToolAction(args), subjectOf(args, context.state.workflowName)]
        .filter(Boolean)
        .join(" ");
      const header = new Text(renderToolHeader({ title: TITLE, subtitle }, theme), 0, 0).render(
        width,
      );
      return context.executionStarted && context.isPartial
        ? [...header, toolRunningLine(theme)]
        : header;
    }),
  );
  if (workflowToolAction(args) === "start" && args.script)
    container.addChild(scriptComponent(args.script, theme, context.expanded));
  return container;
};

const resultText = (result: AgentToolResult<unknown>): string =>
  stripTerminalControls(getTextContent(result.content)).replace(/\n+$/u, "");

/** A routine one-line digest of the result; the agent-facing text waits for expansion. */
const digest = (details: WorkflowToolDetails): string => {
  const run = details.run;
  if (!run) return listCounter(details);
  if (details.action === "start")
    return `Running in the background${run.phases > 0 ? ` · ${countLabel(run.phases, "phase")}` : ""}`;
  if (details.unchanged === true) return `${workflowStateLabel(run.state)} · ${UNCHANGED}`;
  return [
    workflowStateLabel(run.state),
    run.currentPhase ? `phase ${sanitizeTerminalLine(run.currentPhase)}` : "",
    countLabel(run.agents, "agent"),
    ...agentStateParts(run),
  ]
    .filter(Boolean)
    .join(" · ");
};

/** Preview style: a muted digest collapsed, the full output once expanded. */
export const renderWorkflowResult = (
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: WorkflowRenderContext,
): Component => {
  if (options.isPartial) return new Container();
  const details = detailsOf(result);
  if (details?.run) context.state.workflowName = details.run.name;
  if (options.expanded) return renderWorkflowOutput(result, theme);
  // Issues and errors are drawn by the shell; only routine facts belong here.
  if (!details || details.issue) return new Container();
  return new Text(
    `${theme.fg("muted", digest(details))}\n${renderExpansionAffordance("output", false, theme)}`,
    0,
    0,
  );
};

const json = (value: WorkflowToolArgs["args"]) => JSON.stringify(value, null, 2) ?? "null";

/** Compact expansion: every argument exactly, the script in full. */
export const renderWorkflowInput = (args: Partial<WorkflowToolArgs>, theme: Theme): Component => {
  const container = new Container();
  const field = (label: string, value: string | undefined) => {
    if (value !== undefined)
      container.addChild(
        expandedSection(theme, label, new Text(stripTerminalControls(value), 0, 0)),
      );
  };
  field("Saved workflow", args.name);
  field("Script file", args.scriptPath);
  field("Run", args.runId);
  field("Resume from", args.resumeFromRunId);
  field("Budget", args.budget === undefined ? undefined : `${args.budget} output tokens`);
  if (args.script !== undefined)
    container.addChild(expandedSection(theme, "Script", scriptComponent(args.script, theme, true)));
  if ("args" in args) field("Args", json(args.args));
  return container;
};

export const renderWorkflowOutput = (result: AgentToolResult<unknown>, theme: Theme): Component =>
  expandedSection(
    theme,
    "Output",
    new Text(theme.fg("toolOutput", resultText(result) || "(empty)"), 0, 0),
  );
