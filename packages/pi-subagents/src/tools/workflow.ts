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
import { workflowAuthoringGuidePath } from "../boundary/workflow-authoring-guide.ts";
import type { SubagentProfileService } from "../profiles/service.ts";
import { workflowArgsSummary } from "../workflow/args.ts";
import type {
  WorkflowArgsProblem,
  WorkflowNotFoundError,
  WorkflowRequestError,
} from "../workflow/errors.ts";
import type { WorkflowScriptError } from "../workflow/script.ts";
import { WorkflowService, type WorkflowToolStatus } from "../workflow/service.ts";
import {
  savedWorkflowFiles,
  WorkflowStore,
  type SavedWorkflowSummary,
  type WorkflowLocations,
  type WorkflowSourceError,
} from "../workflow/store.ts";
import {
  WORKFLOW_STOP_GUIDANCE,
  workflowListText,
  workflowRecordedRunSummary,
  workflowRecordedStatusText,
  workflowRunSummary,
  workflowStartText,
  workflowStatusText,
  workflowStopText,
  workflowUnchangedStatusText,
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
  workflowToolAction,
} from "./workflow-schema.ts";

/**
 * The description's example script: find by dimension, then three refuters per finding with a
 * majority vote. Exported so tests can run it; the authoring guide holds the longer patterns.
 */
export const workflowToolExample = `export const meta = { name: "review", description: "Find bugs by dimension, merge reports of one location, then verify each with three refuters", phases: [{ title: "Find", agents: ["correctness", "security", "error handling"] }, { title: "Verify" }] };
const BUGS = { type: "object", properties: { bugs: { type: "array", items: { type: "object", properties: { file: { type: "string" }, line: { type: "integer" }, claim: { type: "string" } }, required: ["file", "line", "claim"], additionalProperties: false } } }, required: ["bugs"], additionalProperties: false };
const VERDICT = { type: "object", properties: { refuted: { type: "boolean" }, reason: { type: "string" } }, required: ["refuted", "reason"], additionalProperties: false };
const found = await parallel(["correctness", "security", "error handling"].map((area) => () =>
  agent(\`Review the uncommitted diff in this repository for \${area} bugs. Report only real defects, each with file, line and claim.\`, { label: area, phase: "Find", profile: "reviewer", schema: BUGS })));
// A deliberate barrier: merge the finders' reports of one location before paying to verify it.
const byLocation = new Map();
for (const bug of found.flatMap((review) => review?.bugs ?? [])) {
  const location = \`\${bug.file}:\${bug.line}\`;
  byLocation.set(location, [...(byLocation.get(location) ?? []), bug.claim]);
}
const verified = await parallel([...byLocation].map(([location, claims]) => () =>
  parallel([1, 2, 3].map((n) => () =>
    agent(\`Try to refute these reported bugs at \${location} against the code. Answer refuted: true unless you can confirm one is real.\\n\${claims.join("\\n")}\`, { label: \`refute \${location} #\${n}\`, phase: "Verify", profile: "reviewer", schema: VERDICT })))
    .then((votes) => (votes.filter((vote) => vote && !vote.refuted).length >= 2 ? { location, claims } : null))));
return verified.filter(Boolean);`;

/** The model's documentation for workflow scripts; `locations` resolves saved workflows. */
const description = (
  locations: WorkflowLocations,
): string => `Run a JavaScript workflow that orchestrates subagents in the background. Use it for planned fan-out or multi-stage work: reviews by dimension, per-file or per-item processing, find-then-verify, implement-then-check. Use subagent_start instead for one to three agents you steer yourself, and work solo on small, specific tasks. Size the workflow to the request: a few agents for a focused check, dozens with adversarial verification for a thorough audit or a large implementation. Read the workflow authoring guide (${workflowAuthoringGuidePath()}) before writing a non-trivial script.

start returns at once with a run id, and the script runs in a sandbox. Then end your turn, after any unrelated work: the run's one notification, with its return value or error, starts your next turn automatically, so don't call status to wait for it. Pass budget (output tokens) whenever the user states a token limit for the work, such as 500000 for "cap this at 500k": a hard ceiling on what the run's agents spend, the subagents they start included; agents already running when it is reached finish, so the run can overshoot. status shows a run's progress, usage and anything that needs you, with how to act on it; a repeat within a minute while nothing changed gets one line instead. stop cancels a run and returns its final state, and no notification follows. ${WORKFLOW_STOP_GUIDANCE} list shows saved workflows and this session's runs.

A script is plain JavaScript (not TypeScript) that begins with a pure-literal
export const meta = { name: "review", description: "…", whenToUse: "…", args: { … }, phases: [{ title: "Find", detail: "…", agents: ["finder", { label: "checker", profile: "reviewer" }] }] };
(only name and description are required), followed by top-level code that awaits agents and returns a JSON value. meta.args is a JSON Schema for the start's args (null when omitted), in the subset agent() schemas accept; a start, resume or workflow() call whose args don't match is refused. List the agents you already know in each phase's agents (labels up to 80 characters, 64 per phase, 256 in all) so the user sees the plan and can skip one. Planned agents start nothing and set no options: an agent() call in a phase (by phase() or the phase option) takes that phase's next entry with its label, or, unlabelled, the phase's next entry; a labelled call outside any phase takes the next entry with its label. A call that takes an entry the user skipped resolves null.

Globals:
- agent(prompt, options?) resolves to the agent's final text, or with options.schema to the validated JSON value, and to null when the agent fails, is stopped or is skipped. Options: label (display name), phase, profile (a subagent profile, default generalist; profiles choose model and effort, so model, effort and agentType are rejected), schema (JSON Schema without $ref or $defs; every pattern must compile with the JavaScript u flag), writes (1 to 64 exact workspace-relative files for a writer profile such as worker), isolation: "worktree" (runs a writer in its own worktree). An invalid call fails the run, even inside parallel or pipeline, unless the script catches its error. Once the budget is spent, a call whose agent hasn't started throws a budget error (error.name "WorkflowBudgetError"): uncaught, that fails the run, and inside parallel or pipeline its item yields null. A catch around agent() should rethrow other errors.
- parallel(items) waits for functions such as () => agent(...), which it calls, or promises, running concurrently; an item that throws or rejects yields null.
- pipeline(items, ...stages) passes each item through the stages independently, with no barrier between stages, as stage(previous, item, index), where previous is null after a stage that resolved null; a throwing stage yields null for that item. Prefer it to parallel() between stages unless a stage needs every earlier result together.
- phase(title) groups later agents; log(message) adds a progress line.
- workflow(name or { scriptPath }, args?) runs a saved workflow inline, one level deep; one that doesn't load is an invalid call.
- args is the start args, frozen. budget.total is the start's budget (null without one); budget.spent() counts output tokens of this run's finished agents; budget.remaining() is what's left (Infinity without a total). With a budget, split it across phases before writing the script (keep room to verify and summarize), never start more agents at once than remaining() pays for (a finder reading a package spends 30k to 60k output tokens, a verifier 5k to 15k), and check remaining() before each phase and every top-level call; spent() excludes running agents, so a fan-out wider than that overshoots and later calls throw. Guard loops with it, such as while (budget.total && budget.remaining() > 50000) { ... }.

Rules: prompts must be self-contained, because agents don't see this conversation. Await every agent() call: agents still running when the script returns are stopped. Date.now(), new Date() and Math.random() throw, so runs can resume; there are no timers, fetch, files or modules. Each run executes up to min(16, CPUs - 2) agents at once (at least one), which don't count toward your own subagent limit, and 1000 agent() calls in total, counting calls the budget refused; a call past that fails the run even if caught. Extra calls queue and start in call order, so pass every item. Agents are ordinary subagents: writers follow the session's writer mode and file claims (shared-checkout writers whose writes overlap, or that have none, run one at a time, and one that edits a file it didn't claim is contained), worktree proposals are listed in the notification for review with subagent_workspace, and an agent may ask you a question (answer with subagent_reply; the workflow then continues).

Pass one-off work as an inline script, which is saved to a private file named in the start result; write a saved workflow only when the user wants one to reuse. Saved workflows are ${savedWorkflowFiles(locations)}. Write them with your file tools and start them with name; scriptPath runs any .js file. To fix a failed run, adjust one you stopped yourself, or extend a completed one, edit its script file and start it again with resumeFromRunId: agent() calls with the same prompt, profile, schema, isolation and writes reuse their results, until a writer call without isolation: "worktree" runs live, after which every later call runs live. Don't restart a run the user stopped unless they ask. The notification and status name the run's results journal, one JSON line per finished agent() call; read it before diagnosing an empty or surprising result.

Example (find by dimension, merge reports by location, then three reviewer refuters per location and a majority vote):
${workflowToolExample}`;

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

/** A status call's result: a repeat's short answer while nothing changed, or the full status. */
const statusResult = (status: WorkflowToolStatus, now: number): WorkflowToolResult => {
  switch (status.kind) {
    case "recorded":
      return succeed("status", workflowRecordedStatusText(status.run, now), {
        run: workflowRecordedRunSummary(status.run),
      });
    case "unchanged":
      return succeed("status", workflowUnchangedStatusText(status.run, status.sinceMs), {
        run: workflowRunSummary(status.run),
        unchanged: true,
      });
    case "view":
      return succeed("status", workflowStatusText(status.run, now, status.attention), {
        run: workflowRunSummary(status.run),
      });
  }
};

const executeWorkflowTool = <Args>(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
  args: Args & {
    readonly action?: WorkflowToolAction | undefined;
    readonly script?: string | undefined;
    readonly name?: string | undefined;
    readonly scriptPath?: string | undefined;
  },
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
      case "status":
        return statusResult(
          yield* workflows.toolStatus(request.runId),
          yield* Clock.currentTimeMillis,
        );
      case "stop": {
        const run = yield* workflows.stop(request.runId, "tool");
        const text = workflowStopText(run, yield* Clock.currentTimeMillis);
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
  }).pipe(
    // A call without a recognizable action fails as a start, the default action.
    Effect.catch((error) => Effect.succeed(fail(workflowToolAction(args) ?? "start", error))),
  );

/**
 * Registers the root-only, model-only workflow runner tool, inactive: the application activates
 * it only while the user has opted into workflows with ultracode.
 */
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
      "For planned fan-out or multi-stage work that needs more than a few subagents, write one subagent_workflow script instead of starting and awaiting agents one by one. After starting it, finish any unrelated work and end your turn: its notification starts your next turn with the result. Don't poll status or stop the run to finish sooner.",
      "To fix a failed workflow, adjust one you stopped yourself, or extend a completed one, edit its script and start it again with resumeFromRunId so unchanged agents are reused. A run the user stopped stays stopped unless they ask for it again.",
    ],
    exposure: "model-only",
    defaultActive: false,
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
