import * as Effect from "effect/Effect";
import { hasControlCharacter } from "pi-cosmic-core";
import { type InvalidSubagentRequestError, invalidRequest } from "./errors.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "./limits.ts";
import type { StartSubagentRequest } from "./model.ts";

export const SUBAGENT_TOOL_NAME = Object.freeze({
  models: "subagent_models",
  start: "subagent_start",
  list: "subagent_list",
  status: "subagent_status",
  await: "subagent_await",
  send: "subagent_send",
  reply: "subagent_reply",
  lifecycle: "subagent_lifecycle",
  rename: "subagent_rename",
  claims: "subagent_claims",
  workspace: "subagent_workspace",
} as const);

export const SUBAGENT_TOOL_NAMES = Object.freeze(Object.values(SUBAGENT_TOOL_NAME));
export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

/** Private local Pi child tool for a run with a result contract; never inherited from the root. */
export const SUBAGENT_RESULT_TOOL_NAME = "subagent_result";

/** External competing orchestrators stay disabled, independent of the installed backend adapters. */
export const PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT = [
  "herdr_agent_start",
  "herdr_agent_list",
  "herdr_agent_status",
  "herdr_agent_await",
  "herdr_agent_read",
  "herdr_agent_send",
  "herdr_agent_stop",
  "workflow",
  "workflow_control",
].join(",");

const MAX_INHERITED_PI_TOOL_COUNT = 256;
const MAX_INHERITED_PI_TOOL_NAME_CHARS = 128;
const MAX_INHERITED_PI_TOOL_ARGUMENT_BYTES = 32_768;
const toolNameEncoder = new TextEncoder();

const isCompetingOrchestratorTool = (name: string): boolean =>
  name.startsWith("herdr_agent_") || name === "workflow" || name.startsWith("workflow_");

const unrepresentableToolSnapshot = () =>
  invalidRequest(
    "pi_active_tools_unrepresentable",
    "The root Pi active-tool list cannot be represented safely for a child process. Disable malformed or excessive tools and retry.",
  );

const isCliRepresentableToolName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= MAX_INHERITED_PI_TOOL_NAME_CHARS &&
  name === name.trim() &&
  !name.includes(",") &&
  !hasControlCharacter(name);

/**
 * Capture ordinary root-session tools in active order. Raw coordinator implementations are not
 * inherited: packaged child integrations explicitly register and activate authenticated proxies.
 * Prefix filtering also keeps future tools from known competing coordinator families out of a
 * child even before they are added to the process-level hard-exclusion list. The exact snapshot
 * must survive Pi's comma-delimited CLI parser without normalization or name injection.
 */
export const piRootActiveToolSnapshot = (
  rootActiveTools: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, InvalidSubagentRequestError> => {
  if (rootActiveTools.length > MAX_INHERITED_PI_TOOL_COUNT)
    return Effect.fail(unrepresentableToolSnapshot());
  const inherited: string[] = [];
  const seen = new Set<string>();
  let argumentBytes = 0;
  for (const name of rootActiveTools) {
    if (!isCliRepresentableToolName(name)) return Effect.fail(unrepresentableToolSnapshot());
    if (seen.has(name) || name.startsWith("subagent_") || isCompetingOrchestratorTool(name))
      continue;
    const encodedBytes = toolNameEncoder.encode(name).length + (inherited.length === 0 ? 0 : 1);
    if (argumentBytes + encodedBytes > MAX_INHERITED_PI_TOOL_ARGUMENT_BYTES)
      return Effect.fail(unrepresentableToolSnapshot());
    argumentBytes += encodedBytes;
    seen.add(name);
    inherited.push(name);
  }
  return Effect.succeed(Object.freeze(inherited));
};

/** Shared bound/emptiness policy for every parent-authored message that reaches a child. */
export const validateParentMessage = (
  message: string,
  emptyMessage: string,
): Effect.Effect<string, InvalidSubagentRequestError> => {
  const normalized = message.trim();
  if (!normalized) return Effect.fail(invalidRequest("message_required", emptyMessage));
  if (normalized.length > MAX_PARENT_MESSAGE_CHARS)
    return Effect.fail(
      invalidRequest(
        "message_too_large",
        `Subagent message exceeds ${MAX_PARENT_MESSAGE_CHARS} characters.`,
      ),
    );
  return Effect.succeed(normalized);
};

/** How the run returns its result: a validated value for contract runs, else a prose report. */
const completionInstruction = (request: StartSubagentRequest): string => {
  if (!request.resultContract)
    return "Always end with a concise, self-contained final report containing the actual findings or work completed. Never finish with only an acknowledgement.";
  return request.runtime === "pi"
    ? `A program started you and receives only the arguments of your ${SUBAGENT_RESULT_TOOL_NAME} call. When the task is complete, call ${SUBAGENT_RESULT_TOOL_NAME} exactly once with the final result matching its schema. That call is your return value and ends your run; text you write is not returned. If you cannot finish, still call it with the most accurate result the schema allows.`
    : "A program started you and receives only your final report, parsed as JSON. Your report must be exactly one JSON value matching the result schema below, with the actual findings or work completed. If you cannot finish, still report the most accurate result the schema allows.";
};

export const childSystemPrompt = (request: StartSubagentRequest): string =>
  [
    "You are a subagent working for a supervising Pi session.",
    "Complete the assigned task directly. The parent owns orchestration, task partitioning, and final decisions.",
    "You may delegate bounded independent work through the private subagent tools. The root coordinator enforces your current direct-child and depth limits. Native Claude/Codex agents are internal runtime activity and are not Pi run-tree nodes.",
    ...(request.profile && request.profileGuidance
      ? [`Your assigned profile is ${request.profile}.\n\n${request.profileGuidance}`]
      : []),
    "Before changing or reviewing files, read and follow applicable AGENTS.md instructions in the workspace.",
    "Use contact_parent(kind=progress) only for meaningful progress or discoveries that change the plan.",
    "Use contact_parent(kind=question) when blocked on a decision; wait for the parent reply instead of guessing.",
    ...(request.workflow
      ? [
          "You are one step of an automated workflow. Your final response is returned to the workflow program as data, not shown to a person: return only the requested result, and state assumptions instead of asking unless you are truly blocked.",
        ]
      : []),
    "Use contact_parent(kind=warning) to record a material non-blocking risk in parent-visible run status, and repeat that risk in the final report. Use kind=question instead when the parent must act before you can continue or the risk could invalidate work the parent is doing now.",
    completionInstruction(request),
    ...(request.workspace
      ? [
          `Your isolated workspace is ${request.workspace.cwd}. Its source checkout is ${request.workspace.sourceCwd}. Work only in the isolated workspace; do not write into the source checkout or another worker's directory.`,
          "Your final report is a proposal, not integration approval. Do not stage, commit, merge, or integrate your own proposal. Your direct parent reviews every immutable diff page and runs combined tests in a prepared workspace before integrating uncommitted edits. Isolation is not a filesystem or confidentiality sandbox.",
        ]
      : []),
    request.writeIntent === "writer"
      ? request.writes
        ? [
            request.workspace
              ? "You have an isolated working directory. Exact-file claims still constrain the assigned scope; native tools remain available."
              : "You are one of several cooperative writers in a shared working directory. Native edit, write, and Bash remain available, but file claims are coordination rules rather than filesystem isolation.",
            `Your exact write claims:\n${request.writes.map((path) => `- ${path}`).join("\n")}`,
            request.workspace
              ? "Read repository files as needed, but modify only the claimed paths inside your isolated cwd."
              : "Read any repository file, but modify only the claimed paths. Re-read a file immediately before editing because peers may change the checkout concurrently.",
            "Use Bash for targeted validation and ordinary work, but do not mutate files outside your claims. Do not run Git mutation, package installation, broad formatting, snapshot updates, or broad code generation unless every affected file is explicitly claimed.",
            "If another file is needed, contact the parent with kind=question, name the exact workspace-relative paths, and wait. Only a parent claim grant followed by its reply expands your scope. Peers cannot transfer claims.",
            "Report every changed file, validation command, and any possible out-of-claim side effect in the final report.",
          ].join("\n\n")
        : request.workspace
          ? "You are the writer in an isolated working directory. Keep edits narrowly within the assigned task and report changed files and validation."
          : "You are the exclusive declared writer in the shared working directory. Keep edits narrowly within the assigned task and report changed files and validation."
      : "Your run is declared read-only as a prompt and writer-lease policy, not a tool-capability boundary. Inherited tools may still be capable of mutation; use them only for inspection and validation, and do not edit, write, patch, generate, or otherwise mutate project files. Use a writer assignment for intentional project changes.",
  ].join("\n\n");

export const taskPrompt = (request: StartSubagentRequest, peerNotice: string): string =>
  [`Assigned task:\n${request.task}`, `Workspace coordination:\n${peerNotice}`].join("\n\n");
