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
import { clipText, failureMessage, toPiToolOutputSchema } from "pi-cosmic-core";
import type { SubagentBackendRegistry } from "../backend/service.ts";
import type { SubagentSessionEnvironment } from "../boundary/host-profile-resolution.ts";
import { makeWorkflowHost } from "../boundary/host-workflow.ts";
import { workflowAuthoringGuidePath } from "../boundary/workflow-authoring-guide.ts";
import type { SubagentProfileService } from "../profiles/service.ts";
import { clipWithMarker } from "../run/state.ts";
import { workflowArgsSummary } from "../workflow/args.ts";
import type {
  WorkflowArgsProblem,
  WorkflowNotFoundError,
  WorkflowRequestError,
} from "../workflow/errors.ts";
import type { WorkflowScriptError } from "../workflow/script.ts";
import { WorkflowService, type WorkflowToolStatus } from "../workflow/service.ts";
import {
  withWorkflowContract,
  workflowListContract,
  workflowStartContract,
  workflowStatusContract,
  workflowStopContract,
} from "./workflow-contract.ts";
import { WorkflowContractSchema } from "./workflow-contract-schema.ts";
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
  WorkflowToolInputError,
  workflowToolAction,
} from "./workflow-schema.ts";

/**
 * The description's example script, the focused-check shape: a few finders, a barrier that dedups
 * their reports, then one skeptic per bug. Exported so tests can run it; the authoring guide holds
 * the thorough patterns.
 */
export const workflowToolExample = `export const meta = { name: "find-bugs", description: "A few finders, dedup, then one skeptic per bug", phases: [{ title: "Find", agents: ["logic", "errors"] }, { title: "Verify" }] };
const BUGS = { type: "object", properties: { bugs: { type: "array", items: { type: "object", properties: { file: { type: "string" }, line: { type: "integer" }, desc: { type: "string" } }, required: ["file", "line", "desc"], additionalProperties: false } } }, required: ["bugs"], additionalProperties: false };
const VERDICT = { type: "object", properties: { refuted: { type: "boolean" }, reason: { type: "string" } }, required: ["refuted", "reason"], additionalProperties: false };
// From scouting the diff: the changed files. Each finder takes one lens.
const FILES = ["src/config/store.ts", "src/config/path-key.ts"];
const sameBug = (a, b) => a.file === b.file && Math.abs(a.line - b.line) <= 3;
const found = await parallel(["logic", "errors"].map((lens) => () =>
  agent(\`Review the uncommitted changes to \${FILES.join(", ")} for \${lens} bugs. Report each real one with file, line and desc.\`, { label: lens, phase: "Find", profile: "reviewer", schema: BUGS })));
// A justified barrier: dedup across all finders (same file, lines within 3) before paying to verify.
const bugs = [];
for (const bug of found.flatMap((review) => review?.bugs ?? [])) if (!bugs.some((other) => sameBug(other, bug))) bugs.push(bug);
if (bugs.length === 0) return [];
const verdicts = await parallel(bugs.map((bug) => () =>
  agent(\`Try to refute this reported bug against the code. Default to refuted: true if uncertain.\\n\${JSON.stringify(bug)}\`, { label: \`verify \${bug.file}:\${bug.line}\`, phase: "Verify", profile: "reviewer", schema: VERDICT })));
return bugs.filter((_, index) => verdicts[index]?.refuted === false);`;

/** The model's documentation for workflow scripts; `locations` resolves saved workflows. */
const description = (
  locations: WorkflowLocations,
): string => `Run a JavaScript workflow that orchestrates subagents in the background. Use it for planned fan-out or multi-stage work: reviews by dimension, per-file or per-item processing, find-then-verify, implement-then-check. Use subagent_start instead for one to three agents you steer yourself, and work solo on conversational turns, trivial mechanical edits and checks small enough to verify completely yourself, such as a diff of about ten changed lines or fewer. Scale to what the user asked for: "find any bugs" or reviewing a diff or change → a focused check: read it yourself first, then a few finders with concrete checklists that report every candidate they can back with a failing scenario, and one skeptic per distinct candidate, yours included; "thoroughly audit" or "be comprehensive" → a wide finder pool (one per area plus cross-cutting lenses, typically 10 to 15), a three-lens adversarial panel per finding, and gap rounds of four to six angles a completeness critic proposes; a multi-file implementation → you build the core, then a workflow of four to six writers on disjoint files, then, after your checks, a review workflow of three to five lens reviewers with two skeptics per finding. One task is one workflow: keep finding, verifying and synthesizing in the same script, and chain workflows only between stages of larger work (understand, design, implement, review). Default to pipeline(); use a barrier only when a stage needs all earlier results, such as deduplicating findings before verifying them, by file and nearby line, never by the claim's wording. Read the workflow authoring guide (${workflowAuthoringGuidePath()}) before writing a non-trivial script. The default workflow size is medium: keep a workflow under 10 agents. This is a guideline, not a hard limit: follow it unless the user's request calls for a different scale, such as a thorough audit.

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

Pass one-off work as an inline script, which is saved to a private file named in the start result; write a saved workflow only when the user wants one to reuse. Saved workflows are ${savedWorkflowFiles(locations)}. Write them with your file tools and start them with name; scriptPath runs any .js file. For a runtime failure, follow the supplied recovery guidance rather than editing the script. To fix a script error, adjust a run you stopped yourself, or extend a completed one, edit its script file and start it again with resumeFromRunId: agent() calls with the same prompt, profile, schema, isolation and writes reuse their results, until a writer call without isolation: "worktree" runs live, after which every later call runs live. Don't restart a run the user stopped unless they ask. The notification and status name the run's results journal, one JSON line per finished agent() call; read it before diagnosing an empty or surprising result.

Example of a focused check ("find any bugs"); the guide's exhaustive review shows the thorough shape:
${workflowToolExample}`;

const SAVED_LISTED = 20;
const SAVED_TEXT_CHARS = 200;
const savedText = (text: string): string => clipWithMarker(text, SAVED_TEXT_CHARS, "…");

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

const REQUEST_MESSAGES = {
  resume_running: "The run to resume is still running",
  resume_running_elsewhere: "The run to resume is still running in another Pi process",
  resume_unrecorded: "The run to resume left no run record",
  resume_unknown: "The run to resume isn't known to this session",
  resume_other_session: "The run to resume belongs to another session",
  resume_unreadable: "The run to resume couldn't be read",
  args_too_large: "Workflow args are larger than 64 KiB",
} as const satisfies Record<Exclude<WorkflowRequestError["code"], "args_mismatch">, string>;

const requestMessage = (error: WorkflowRequestError): string =>
  error.code === "args_mismatch"
    ? argsMismatchMessage(error.argsProblems)
    : REQUEST_MESSAGES[error.code];

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
    const request = decodeWorkflowToolRequest(args);
    if (request instanceof WorkflowToolInputError) return yield* request;
    const workflows = yield* WorkflowService;
    switch (request.action) {
      case "start": {
        const host = yield* makeWorkflowHost(pi, ctx, environment);
        const run = yield* workflows.start(request.start, host);
        return withWorkflowContract(
          succeed("start", workflowStartText(run), { run: workflowRunSummary(run) }),
          () => workflowStartContract(run),
        );
      }
      case "status": {
        const status = yield* workflows.toolStatus(request.runId);
        return withWorkflowContract(statusResult(status, yield* Clock.currentTimeMillis), () =>
          workflowStatusContract(status),
        );
      }
      case "stop": {
        const run = yield* workflows.stop(request.runId, "tool");
        const text = workflowStopText(run, yield* Clock.currentTimeMillis);
        return withWorkflowContract(succeed("stop", text, { run: workflowRunSummary(run) }), () =>
          workflowStopContract(run),
        );
      }
      case "list": {
        const listing = yield* WorkflowStore.use((store) => store.list);
        const runs = yield* workflows.list;
        return withWorkflowContract(
          succeed("list", workflowListText(listing, runs), {
            saved: listing.workflows.length,
            diagnostics: listing.diagnostics.length,
            runs: runs.length,
          }),
          () => workflowListContract(listing, runs),
        );
      }
    }
  }).pipe(
    // A call without a recognizable action fails as a start, the default action.
    Effect.catch((error) => Effect.succeed(fail(workflowToolAction(args) ?? "start", error))),
  );

/**
 * Registers the root-only workflow runner tool, inactive: the application activates
 * it only while the user has opted into workflows with ultracode. `shell` is the application's
 * replay-staging wrapper, which stages history presentation without touching activation.
 */
export function registerWorkflowTool(
  pi: ExtensionAPI,
  runtime: WorkflowToolRuntime,
  shell: typeof withCodePreviewShell = withCodePreviewShell,
): void {
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
      "For a runtime failure, follow the supplied recovery guidance rather than editing the script. To fix a script error, adjust a workflow you stopped yourself, or extend a completed one, edit its script and start it again with resumeFromRunId so unchanged agents are reused. A run the user stopped stays stopped unless they ask for it again.",
      "Native codemode may call subagent_workflow only while Ultracode makes it active. Starting a workflow authorizes its ordinary agents, including writers: use only the user-authorized task, with normal writer mode, claims and worktree review. Questions, claim recovery and workspace integration remain main-agent decisions, not scripted approvals.",
      "Native codemode receives success-only pi-subagents/workflow version-1 envelopes. Check contract, version, tool and action, and print a start's run.id immediately. A start is a receipt, not completion; end the turn for the notification, never poll status. Status kind distinguishes a live view, unchanged live view, and recorded summary; recorded finished counts agent results. Terminal workflow state does not prove child process cleanup, and result is bounded text with clipped and optional path, not a parsed full value. Rejected or cancelled calls do not roll back admitted effects: hand uncertainty to the main agent to inspect existing runs, never replay a start blindly.",
    ],
    // Direct exposure is callable only while active, preserving the Ultracode opt-in.
    exposure: "direct",
    defaultActive: false,
    parameters: WorkflowToolParameters,
    outputSchema: toPiToolOutputSchema(WorkflowContractSchema),
    execute: (_id, args, signal, _onUpdate, ctx) =>
      runtime.run(executeWorkflowTool(pi, ctx, runtime.environment, args), signal),
    renderCall: renderWorkflowCall,
    renderResult: renderWorkflowResult,
  });
  pi.registerTool(
    shell(tool, {
      ...(runtime.scheduleAnimation && { scheduleAnimation: runtime.scheduleAnimation }),
      compactSummary: workflowCompactSummary,
      expandedContent: {
        renderCall: renderWorkflowInput,
        renderResult: (result, _options, theme) => renderWorkflowOutput(result, theme),
      },
    }),
  );
}
