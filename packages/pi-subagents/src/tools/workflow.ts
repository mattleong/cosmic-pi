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
import type { WorkflowScriptError } from "../workflow/script.ts";
import {
  WorkflowService,
  type WorkflowNotFoundError,
  type WorkflowRequestError,
} from "../workflow/service.ts";
import {
  WorkflowStore,
  type SavedWorkflowSummary,
  type WorkflowSourceError,
} from "../workflow/store.ts";
import {
  workflowListText,
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

/** The model's only documentation for workflow scripts. */
const DESCRIPTION = `Run a JavaScript workflow that orchestrates subagents in the background. Use it for planned multi-step or fan-out work: reviews by dimension, per-file or per-item processing, find-then-verify, implement-then-check, especially when it needs more than a few agents or several stages. Use subagent_start instead for one to three agents you steer yourself.

start returns at once with a run id. The script runs in a sandbox while you keep working, and exactly one notification arrives with its return value or error; don't wait or poll for it. status shows progress, stop cancels and returns the final state (no notification follows unless the stop call itself is interrupted), list shows saved workflows and this session's runs. Reloading, /tree navigation or replacing the session stops running workflows and their agents; the next session start posts one notice per interrupted run.

A script is plain JavaScript (not TypeScript) that begins with a pure-literal
export const meta = { name: "review", description: "…", whenToUse: "…", phases: [{ title: "Find", detail: "…" }] };
(whenToUse, phases and detail are optional), followed by top-level code that awaits agents and returns a JSON value.

Globals:
- agent(prompt, options?) resolves to the agent's final text, or with options.schema to the validated JSON value. It resolves null when the agent fails, is stopped or is skipped, and rejects only for an invalid call. Options: label (display name, clipped to 80 characters), phase, profile (a subagent profile, default generalist; profiles choose model and effort, so model, effort and agentType are rejected), schema (JSON Schema without $ref or $defs), writes (exact workspace-relative files for a writer profile such as worker), isolation: "worktree" (runs a writer in its own worktree).
- parallel(thunks) runs functions concurrently and waits for all; a thunk that throws yields null.
- pipeline(items, ...stages) passes each item through the stages independently as stage(previous, item, index); a throwing stage yields null for that item.
- phase(title) groups later agents; log(message) adds a progress line.
- workflow(name or { scriptPath }, args?) runs a saved workflow inline, one level deep.
- args is the start args, frozen; budget.spent() counts output tokens used so far.

Rules: prompts must be self-contained, because agents don't see this conversation. Await every agent() call: agents still running when the script returns are stopped. Date.now(), new Date() and Math.random() throw, so runs can resume; there are no timers, fetch, files or modules. Up to min(16, CPUs - 2) agents run at once and 1000 per run; extra calls queue. Agents are ordinary subagents: writers follow the session's writer mode and file claims (shared-checkout writers without disjoint writes run one at a time; the others queue), worktree proposals are listed in the notification for review with subagent_workspace, and an agent may ask you a question (answer with subagent_reply; the workflow then continues).

Saved workflows are <project>/.pi/workflows/<name>.js (trusted projects only) and <agent-dir>/workflows/<name>.js. Write them with your file tools and start them with name; scriptPath runs any .js file. After fixing a failed script, or one you stopped yourself to change it, start it with resumeFromRunId to reuse results of agent() calls with the same prompt, profile, schema, isolation and writes. Don't restart a run the user stopped unless they ask.

Example:
export const meta = { name: "review", description: "Review the diff, then verify findings", phases: [{ title: "Review" }, { title: "Verify" }] };
const BUGS = { type: "object", properties: { bugs: { type: "array", items: { type: "string" } } }, required: ["bugs"], additionalProperties: false };
const found = await parallel(["correctness", "security"].map((area) => () =>
  agent(\`Review the uncommitted diff in this repository for \${area} bugs. Report only real defects, each with file and line.\`, { phase: "Review", profile: "reviewer", schema: BUGS })));
phase("Verify");
const bugs = found.flatMap((review) => review?.bugs ?? []);
const verdicts = await parallel(bugs.map((bug) => () => agent(\`Check this reported bug against the code. Answer "real" or "false" first: \${bug}\`, { profile: "reviewer" })));
return bugs.filter((_, index) => verdicts[index]?.trim().toLowerCase().startsWith("real"));`;

const SAVED_LISTED = 20;
const SAVED_TEXT_CHARS = 200;
const savedText = (text: string): string =>
  text.length > SAVED_TEXT_CHARS ? `${text.slice(0, SAVED_TEXT_CHARS - 1)}…` : text;

/** Appends the saved workflows a session can start by name, like Claude Code's workflow list. */
export const workflowToolDescription = (saved: ReadonlyArray<SavedWorkflowSummary>): string => {
  if (saved.length === 0) return DESCRIPTION;
  const lines = saved.slice(0, SAVED_LISTED).map(({ name, scope, meta }) => {
    const when = meta.whenToUse ? ` Use when: ${savedText(meta.whenToUse)}` : "";
    return `- ${name} (${scope}): ${savedText(meta.description)}${when}`;
  });
  const more =
    saved.length > SAVED_LISTED
      ? `\n- …and ${saved.length - SAVED_LISTED} more; use action "list".`
      : "";
  return `${DESCRIPTION}\n\nSaved workflows in this session (start with action "start" and name):\n${lines.join("\n")}${more}`;
};

export interface WorkflowToolRuntime {
  readonly environment: SubagentSessionEnvironment;
  /** Saved workflows found when the session started, listed in the description. */
  readonly savedWorkflows?: ReadonlyArray<SavedWorkflowSummary> | undefined;
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

const requestMessage = (code: string): string => {
  switch (code) {
    case "resume_running":
      return "The run to resume is still running";
    case "resume_unknown":
      return "The run to resume isn't known to this session";
    case "args_too_large":
      return "Workflow args are larger than 64 KiB";
    default:
      return "The workflow couldn't start";
  }
};

/** Parser errors are terse, so they get a subject; meta errors already read as sentences. */
const scriptIssueMessage = (message: string): string => {
  const reason = clipText(failureMessage(message, "The workflow script is invalid"), 100);
  return message.startsWith("SyntaxError") ? `Script syntax error: ${reason}` : reason;
};

/** A short human message for the row; the full text and recovery stay agent-facing. */
const issueFor = (error: WorkflowToolError) => {
  switch (error._tag) {
    case "WorkflowToolInputError":
      return { code: "workflow-arguments", message: "Arguments don't fit the requested action" };
    case "WorkflowScriptError":
      return { code: "workflow-script-invalid", message: scriptIssueMessage(error.message) };
    case "WorkflowSourceError":
      return {
        code: "workflow-source",
        message: clipText(
          failureMessage(error.message, "The workflow script couldn't be read"),
          100,
        ),
      };
    case "WorkflowRequestError":
      return {
        code: `workflow-${error.code.replaceAll("_", "-")}`,
        message: requestMessage(error.code),
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
      case "status":
      case "stop": {
        const run = yield* request.action === "stop"
          ? workflows.stop(request.runId, "tool")
          : workflows.status(request.runId);
        const text = workflowStatusText(run, yield* Clock.currentTimeMillis);
        return succeed(request.action, text, { run: workflowRunSummary(run) });
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
    description: workflowToolDescription(runtime.savedWorkflows ?? []),
    promptSnippet:
      "Run planned multi-agent JavaScript workflows in the background and get one result notification",
    promptGuidelines: [
      "For planned fan-out or multi-stage work that needs more than a few subagents, write one subagent_workflow script instead of starting and awaiting agents one by one, then continue other work until its notification arrives.",
      "When a workflow fails, or you stopped it yourself to fix it, fix the script and start it again with resumeFromRunId so finished agents are reused. A run the user stopped stays stopped unless they ask for it again.",
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
