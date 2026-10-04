// Pi tool execution is a Promise-shaped host boundary.
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { withCodePreviewShell, type CompactAnimationScheduler } from "pi-code-previews";
import { clipText, failureMessage } from "pi-cosmic-core";
import type { SubagentBackendRegistry } from "../backend/service.ts";
import type { SubagentSessionEnvironment } from "../boundary/host-profile-resolution.ts";
import { makeWorkflowHost } from "../boundary/host-workflow.ts";
import type { SubagentProfileService } from "../profiles/service.ts";
import { workflowArgsSummary } from "../workflow/args.ts";
import type {
  WorkflowArgsProblem,
  WorkflowNotFoundError,
  WorkflowRequestError,
} from "../workflow/errors.ts";
import type { WorkflowScriptError } from "../workflow/script.ts";
import { WorkflowService } from "../workflow/service.ts";
import {
  savedWorkflowFiles,
  WorkflowStore,
  type SavedWorkflowSummary,
  type WorkflowLocations,
  type WorkflowSourceError,
} from "../workflow/store.ts";
import {
  workflowListText,
  workflowRecordedRunSummary,
  workflowRecordedStatusText,
  workflowRunSummary,
  workflowStartText,
  workflowStatusText,
} from "./workflow-format.ts";
import {
  renderWorkflowCall,
  renderWorkflowInput,
  renderWorkflowOutput,
  renderWorkflowResult,
  workflowCompactSummary,
  type WorkflowRenderState,
} from "./workflow-presentation.ts";
import {
  decodeWorkflowToolRequest,
  WORKFLOW_TOOL_NAME,
  WorkflowToolParameters,
  type WorkflowToolAction,
  type WorkflowToolDetails,
  type WorkflowToolInputError,
} from "./workflow-schema.ts";

/** The model's only documentation for workflow scripts; `locations` resolves saved workflows. */
const description = (
  locations: WorkflowLocations,
): string => `Run a JavaScript workflow that orchestrates subagents in the background. Use it for planned multi-step or fan-out work: reviews by dimension, per-file or per-item processing, find-then-verify, implement-then-check, especially when it needs more than a few agents or several stages. Use subagent_start instead for one to three agents you steer yourself.

start returns at once with a run id. Pass budget (output tokens) whenever the user states a token limit for the work, such as 500000 for "cap this at 500k": it is a hard ceiling, so once the run's agents have spent it, counting running agents' live usage and the subagents they start themselves, every agent() call that hasn't started throws a budget error while agents already running finish, which can overshoot by what they spend. The script runs in a sandbox while you keep working, and exactly one notification arrives with its return value or error; don't wait or poll for it. status shows progress and usage (tokens, cost when known, tool uses), what needs you (agent questions to answer with subagent_reply, paused or contained agents with how to recover them, agents queued behind a paused writer), and the agents worth a look: running ones with elapsed time first, then failed or skipped ones with reasons, then queued ones with what they wait for. Agents that started show their subagent run id: inspect one with subagent_status, and a subagent_lifecycle stop on a running one makes its agent() call resolve null; queued agents have no subagent yet. For this session's runs from before a reload or Pi restart, status shows a summary from the run's files instead; stop cancels and returns the final state (no notification follows unless the stop call itself is interrupted); list shows saved workflows and this session's runs. Reloading, /tree navigation, replacing the session or exiting Pi stops running workflows and their agents; the next start of the same session, including pi --continue after a restart, posts one notice per interrupted run.

A script is plain JavaScript (not TypeScript) that begins with a pure-literal
export const meta = { name: "review", description: "…", whenToUse: "…", phases: [{ title: "Find", detail: "…", agents: ["finder", { label: "checker", profile: "reviewer" }] }] };
(whenToUse, args, phases, detail and agents are optional), followed by top-level code that awaits agents and returns a JSON value. Declare meta.args, a JSON Schema for the script's args in the subset agent() schemas accept (any root), such as args: { type: "object", properties: { target: { type: "string" } }, required: ["target"] }, so a start, resume or workflow() call whose args (null when omitted) don't match is refused with the failing path, and saved workflows show what to pass. List the agents you already know in each phase's agents (labels up to 80 characters; 64 per phase, 256 in all) so the user sees the plan before they run. They start nothing and set no options (pass profile to agent() too): an agent() call in that phase with the same label, or with no label, takes the next planned entry, and a labelled call before any phase takes its own workflow's entry with that label and that entry's phase. The user can skip a planned agent before it starts; the call that takes it then resolves null.

Globals:
- agent(prompt, options?) resolves to the agent's final text, or with options.schema to the validated JSON value. It resolves null when the agent fails, is stopped or is skipped. Once the budget is spent it throws a budget error (error.name "WorkflowBudgetError") instead of starting an agent: uncaught, that fails the run, and inside parallel or pipeline its item yields null. A catch around agent() should rethrow other errors. An invalid call fails the run, even inside parallel or pipeline, unless the script catches its error. Options: label (display name, clipped to 80 characters), phase, profile (a subagent profile, default generalist; profiles choose model and effort, so model, effort and agentType are rejected), schema (JSON Schema without $ref or $defs; every pattern must compile with the JavaScript u flag, so escape - only inside a character class), writes (exact workspace-relative files for a writer profile such as worker), isolation: "worktree" (runs a writer in its own worktree).
- parallel(items) waits for functions or promises running concurrently: each item is a function such as () => agent(...), which it calls, or a promise such as agent(...) itself. An item that throws or rejects yields null.
- pipeline(items, ...stages) passes each item through the stages independently as stage(previous, item, index); a throwing stage yields null for that item.
- phase(title) groups later agents; log(message) adds a progress line.
- workflow(name or { scriptPath }, args?) runs a saved workflow inline, one level deep. A name or path that doesn't load, or args that don't match its meta.args, make it an invalid call.
- args is the start args, frozen. budget.total is the start's budget (null without one); budget.spent() counts output tokens of this run's finished agents, including the subagents they started, and reused results add nothing; budget.remaining() is what's left (Infinity without a total). Guard loops with it, such as while (budget.total && budget.remaining() > 50000) { ... }: a sequential loop then never hits the budget error, but spent() excludes running agents, which the ceiling counts, so a concurrent fan-out can still overshoot and see throws. A nested workflow() shares the budget.

Rules: prompts must be self-contained, because agents don't see this conversation. Await every agent() call: agents still running when the script returns are stopped. Date.now(), new Date() and Math.random() throw, so runs can resume; there are no timers, fetch, files or modules. Each run executes up to min(16, CPUs - 2, maxDirectChildren - 2) agents at once (at least one) and 1000 agent() calls in total, counting calls the budget refused; a call past that fails the run even if caught. Extra calls queue and start in the order they were made, across runs. Workflow agents leave 2 of the root's direct-child slots for your own subagent_start, unless no workflow agent is running. Agents are ordinary subagents: writers follow the session's writer mode and file claims (shared-checkout writers without disjoint writes run one at a time; the others queue), worktree proposals are listed in the notification for review with subagent_workspace (a worktree writer that made no changes, not even an untracked or ignored file, has its worktree discarded and is only counted), and an agent may ask you a question (answer with subagent_reply; the workflow then continues).

Saved workflows are ${savedWorkflowFiles(locations)}. Write them with your file tools and start them with name; scriptPath runs any .js file. To change a saved workflow or script file, edit that file and start it again with name or scriptPath. An inline script is saved to a private file named in the start result: to change it, edit that file and start it with scriptPath. To fix a failed script, adjust one you stopped yourself, or extend a completed run, edit it and start it with resumeFromRunId to reuse results of agent() calls with the same prompt, profile, schema, isolation and writes (this works for the session's runs after a Pi restart too, while their run files remain); once a writer-profile call without isolation: "worktree" runs live instead of being reused (changed, new, unfinished before, or its earlier worktree can no longer be reused), every later call runs live too. Don't restart a run the user stopped unless they ask. The notification and status name the run's results journal, one JSON line per finished agent() call (label, phase, state, usage, result); Read it to check what each agent actually returned.

Example:
export const meta = { name: "review", description: "Review the diff, then verify findings", phases: [{ title: "Review", agents: ["correctness", "security"] }, { title: "Verify" }] };
const BUGS = { type: "object", properties: { bugs: { type: "array", items: { type: "string" } } }, required: ["bugs"], additionalProperties: false };
const VERDICT = { type: "object", properties: { real: { type: "boolean" }, reason: { type: "string" } }, required: ["real"], additionalProperties: false };
const found = await parallel(["correctness", "security"].map((area) => () =>
  agent(\`Review the uncommitted diff in this repository for \${area} bugs. Report only real defects, each with file and line.\`, { label: area, phase: "Review", profile: "reviewer", schema: BUGS })));
phase("Verify");
const bugs = found.flatMap((review) => review?.bugs ?? []);
const verdicts = await parallel(bugs.map((bug) => () => agent(\`Check this reported bug against the code and decide whether it is real: \${bug}\`, { profile: "reviewer", schema: VERDICT })));
return bugs.filter((_, index) => verdicts[index]?.real);`;

const SAVED_LISTED = 20;
const SAVED_TEXT_CHARS = 200;
const savedText = (text: string): string =>
  text.length > SAVED_TEXT_CHARS ? `${text.slice(0, SAVED_TEXT_CHARS - 1)}…` : text;

/** Appends the saved workflows a session can start by name, like Claude Code's workflow list. */
export const workflowToolDescription = (
  saved: ReadonlyArray<SavedWorkflowSummary>,
  locations: WorkflowLocations,
): string => {
  const base = description(locations);
  if (saved.length === 0) return base;
  const lines = saved.slice(0, SAVED_LISTED).map(({ name, scope, meta }) => {
    const when = meta.whenToUse ? ` Use when: ${savedText(meta.whenToUse)}` : "";
    const args = meta.args === undefined ? "" : ` Args: ${workflowArgsSummary(meta.args)}`;
    return `- ${name} (${scope}): ${savedText(meta.description)}${when}${args}`;
  });
  const more =
    saved.length > SAVED_LISTED
      ? `\n- …and ${saved.length - SAVED_LISTED} more; use action "list".`
      : "";
  return `${base}\n\nSaved workflows in this session (start with action "start" and name):\n${lines.join("\n")}${more}`;
};

export interface WorkflowToolRuntime {
  readonly environment: SubagentSessionEnvironment;
  /** Saved workflows found when the session started, listed in the description. */
  readonly savedWorkflows?: ReadonlyArray<SavedWorkflowSummary> | undefined;
  /** Where saved workflows were found when the session started, named in the description. */
  readonly savedWorkflowLocations: WorkflowLocations;
  readonly scheduleAnimation?: CompactAnimationScheduler | undefined;
  readonly run: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      WorkflowService | WorkflowStore | SubagentProfileService | SubagentBackendRegistry
    >,
    signal?: AbortSignal,
  ) => Promise<A>;
}

type WorkflowToolResult = AgentToolResult<WorkflowToolDetails>;
type WorkflowToolError =
  | WorkflowToolInputError
  | WorkflowScriptError
  | WorkflowSourceError
  | WorkflowRequestError
  | WorkflowNotFoundError;

const succeed = (
  action: WorkflowToolAction,
  text: string,
  facts: Omit<WorkflowToolDetails, "version" | "action">,
): WorkflowToolResult => ({
  content: [{ type: "text", text }],
  details: { version: 1, action, ...facts },
});

/** Longest collapsed issue message, as the shared presentation standard bounds it. */
const ISSUE_MESSAGE_MAX_CHARS = 120;

/**
 * Where args first don't match the workflow's schema, in one short line; the rest are counted.
 * The problem gets whatever the path and count leave of the line.
 */
const argsMismatchMessage = (problems: ReadonlyArray<WorkflowArgsProblem> = []): string => {
  const [first, ...rest] = problems;
  if (!first) return "Args don't match the workflow's schema";
  const more = rest.length > 0 ? ` (${rest.length} more)` : "";
  const head = `Args don't match the workflow at ${clipText(first.path, 36)}: `;
  return `${head}${clipText(first.problem, ISSUE_MESSAGE_MAX_CHARS - head.length - more.length)}${more}`;
};

const requestMessage = (error: WorkflowRequestError): string => {
  switch (error.code) {
    case "resume_running":
      return "The run to resume is still running";
    case "resume_running_elsewhere":
      return "The run to resume is still running in another Pi process";
    case "resume_unrecorded":
      return "The run to resume left no run record";
    case "resume_unknown":
      return "The run to resume isn't known to this session";
    case "resume_other_session":
      return "The run to resume belongs to another session";
    case "resume_unreadable":
      return "The run to resume couldn't be read";
    case "args_too_large":
      return "Workflow args are larger than 64 KiB";
    case "args_mismatch":
      return argsMismatchMessage(error.argsProblems);
  }
};

/** Where a script names in compact messages: `Script` inline, or its file's name. */
const INLINE_SCRIPT = "Script";

/**
 * Why a script can't run, in one short line: the parser's message with its line, since parser
 * errors are terse, or else why it isn't a valid workflow, which already reads as a sentence.
 */
const scriptIssueMessage = (error: WorkflowScriptError, subject = INLINE_SCRIPT): string => {
  const syntax = error.syntax;
  if (syntax !== undefined)
    return `${subject} syntax error: ${clipText(syntax.reason, 60)}${syntax.line === undefined ? "" : ` (line ${syntax.line})`}`;
  const reason = clipText(failureMessage(error.message, "The workflow script is invalid"), 90);
  return subject === INLINE_SCRIPT ? reason : `${subject}: ${reason}`;
};

/** A source that couldn't load, named by its file's or saved workflow's name, never its path. */
const sourceIssueMessage = (error: WorkflowSourceError): string => {
  const subject = clipText(error.subject, 60);
  switch (error.problem) {
    case "unreadable":
      return `Couldn't read ${subject}`;
    case "not-utf8":
      return `${subject} isn't valid UTF-8`;
    case "script":
      return error.script === undefined
        ? `${subject} isn't a valid workflow script`
        : scriptIssueMessage(error.script, subject);
    case "not-found":
      return `No saved workflow named ${JSON.stringify(subject)}`;
    case "bad-name":
      return `${JSON.stringify(subject)} isn't a valid workflow name`;
    case "not-js":
      return `${subject} isn't a .js file`;
    case "bad-reference":
      return "A nested workflow names neither a saved workflow nor a script file";
  }
};

/** A short human message for the row; the full text and recovery stay agent-facing. */
const issueFor = (error: WorkflowToolError) => {
  switch (error._tag) {
    case "WorkflowToolInputError":
      return { code: "workflow-arguments", message: "Arguments don't fit the requested action" };
    case "WorkflowScriptError":
      return { code: "workflow-script-invalid", message: scriptIssueMessage(error) };
    case "WorkflowSourceError":
      return { code: "workflow-source", message: sourceIssueMessage(error) };
    case "WorkflowRequestError":
      return {
        code: `workflow-${error.code.replaceAll("_", "-")}`,
        message: requestMessage(error),
      };
    case "WorkflowNotFoundError":
      return { code: "workflow-not-found", message: "That workflow run isn't in this session" };
  }
};

const RECOVERY = {
  WorkflowToolInputError: "Correct the arguments and call subagent_workflow again.",
  WorkflowScriptError: "Fix the script and call start again; nothing ran.",
  WorkflowSourceError: "Check the name or path, or use action list to see saved workflows.",
  WorkflowRequestError: "Nothing ran. Adjust the request and call start again.",
  WorkflowNotFoundError: "Use action list to see this session's runs.",
} as const satisfies Readonly<Record<WorkflowToolError["_tag"], string>>;

const fail = (action: WorkflowToolAction, error: WorkflowToolError): WorkflowToolResult => {
  const issue = issueFor(error);
  return {
    content: [{ type: "text", text: `${error.message}\n\n${RECOVERY[error._tag]}` }],
    details: { version: 1, action, issue: { ...issue, detail: error.message } },
    isError: true,
  };
};

const executeWorkflowTool = <Args>(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
  args: Args & { readonly action: WorkflowToolAction },
) =>
  Effect.gen(function* () {
    const request = yield* decodeWorkflowToolRequest(args);
    const workflows = yield* WorkflowService;
    switch (request.action) {
      case "start": {
        const host = yield* makeWorkflowHost(pi, ctx, environment);
        const run = yield* workflows.start(request.start, host);
        return succeed("start", workflowStartText(run), { run: workflowRunSummary(run) });
      }
      case "status": {
        const status = yield* workflows.status(request.runId);
        const now = yield* Clock.currentTimeMillis;
        return status.kind === "recorded"
          ? succeed("status", workflowRecordedStatusText(status.run, now), {
              run: workflowRecordedRunSummary(status.run),
            })
          : succeed("status", workflowStatusText(status.run, now, status.attention), {
              run: workflowRunSummary(status.run),
            });
      }
      case "stop": {
        const run = yield* workflows.stop(request.runId, "tool");
        const text = workflowStatusText(run, yield* Clock.currentTimeMillis);
        return succeed("stop", text, { run: workflowRunSummary(run) });
      }
      case "list": {
        const listing = yield* WorkflowStore.use((store) => store.list);
        const runs = yield* workflows.list;
        return succeed("list", workflowListText(listing, runs), {
          saved: listing.workflows.length,
          diagnostics: listing.diagnostics.length,
          runs: runs.length,
        });
      }
    }
  }).pipe(Effect.catch((error) => Effect.succeed(fail(args.action, error))));

/** Registers the root-only, model-only workflow runner tool. */
export function registerWorkflowTool(pi: ExtensionAPI, runtime: WorkflowToolRuntime): void {
  const tool = defineTool<typeof WorkflowToolParameters, WorkflowToolDetails, WorkflowRenderState>({
    name: WORKFLOW_TOOL_NAME,
    label: "Subagent Workflow",
    description: workflowToolDescription(
      runtime.savedWorkflows ?? [],
      runtime.savedWorkflowLocations,
    ),
    promptSnippet:
      "Run planned multi-agent JavaScript workflows in the background and get one result notification",
    promptGuidelines: [
      "For planned fan-out or multi-stage work that needs more than a few subagents, write one subagent_workflow script instead of starting and awaiting agents one by one, then continue other work until its notification arrives.",
      "To fix a failed workflow, adjust one you stopped yourself, or extend a completed one, edit its script and start it again with resumeFromRunId so unchanged agents are reused. A run the user stopped stays stopped unless they ask for it again.",
    ],
    exposure: "model-only",
    parameters: WorkflowToolParameters,
    execute: (_id, args, signal, _onUpdate, ctx) =>
      runtime.run(executeWorkflowTool(pi, ctx, runtime.environment, args), signal),
    renderCall: (args, theme, context) => renderWorkflowCall(args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderWorkflowResult(result, options, theme, context),
  });
  pi.registerTool(
    withCodePreviewShell(tool, {
      ...(runtime.scheduleAnimation && { scheduleAnimation: runtime.scheduleAnimation }),
      compactSummary: workflowCompactSummary,
      expandedContent: {
        renderCall: (args, theme) => renderWorkflowInput(args, theme),
        renderResult: (result, _options, theme) => renderWorkflowOutput(result, theme),
      },
    }),
  );
}
