import * as Effect from "effect/Effect";
import { InvalidSubagentRequestError } from "./errors.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "./limits.ts";
import type { StartSubagentRequest } from "./model.ts";

export const SUBAGENT_TOOL_NAMES = [
  "subagent_models",
  "subagent_start",
  "subagent_list",
  "subagent_status",
  "subagent_await",
  "subagent_send",
  "subagent_reply",
  "subagent_lifecycle",
  "subagent_rename",
  "subagent_claims",
] as const;

/** Competing orchestrators stay disabled even when the root session has them active. */
export const PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_NAMES = [
  "herdr_agent_start",
  "herdr_agent_list",
  "herdr_agent_status",
  "herdr_agent_await",
  "herdr_agent_read",
  "herdr_agent_send",
  "herdr_agent_stop",
  "workflow",
  "workflow_control",
] as const;

export const PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT =
  PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_NAMES.join(",");

const MAX_INHERITED_PI_TOOL_COUNT = 256;
const MAX_INHERITED_PI_TOOL_NAME_CHARS = 128;
const MAX_INHERITED_PI_TOOL_ARGUMENT_BYTES = 32_768;
const toolNameEncoder = new TextEncoder();

const isCompetingOrchestratorTool = (name: string): boolean =>
  name.startsWith("herdr_agent_") || name === "workflow" || name.startsWith("workflow_");

const unrepresentableToolSnapshot = () =>
  new InvalidSubagentRequestError({
    code: "pi_active_tools_unrepresentable",
    message:
      "The root Pi active-tool list cannot be represented safely for a child process. Disable malformed or excessive tools and retry.",
  });

const hasToolNameControlCharacter = (name: string): boolean => {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
};

const isCliRepresentableToolName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= MAX_INHERITED_PI_TOOL_NAME_CHARS &&
  name === name.trim() &&
  !name.includes(",") &&
  !hasToolNameControlCharacter(name);

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
  if (!normalized)
    return Effect.fail(
      new InvalidSubagentRequestError({ code: "message_required", message: emptyMessage }),
    );
  if (normalized.length > MAX_PARENT_MESSAGE_CHARS)
    return Effect.fail(
      new InvalidSubagentRequestError({
        code: "message_too_large",
        message: `Subagent message exceeds ${MAX_PARENT_MESSAGE_CHARS} characters.`,
      }),
    );
  return Effect.succeed(normalized);
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
    "Use contact_parent(kind=warning) to record a material non-blocking risk in parent-visible run status, and repeat that risk in the final report. Use kind=question instead when the parent must act before you can continue or the risk could invalidate work the parent is doing now.",
    "Always end with a concise, self-contained final report containing the actual findings or work completed. Never finish with only an acknowledgement.",
    request.writeIntent === "writer"
      ? request.writes
        ? [
            "You are one of several cooperative writers in a shared working directory. Native edit, write, and Bash remain available, but file claims are coordination rules rather than filesystem isolation.",
            `Your exact write claims:\n${request.writes.map((path) => `- ${path}`).join("\n")}`,
            "Read any repository file, but modify only the claimed paths. Re-read a file immediately before editing because peers may change the checkout concurrently.",
            "Use Bash for targeted validation and ordinary work, but do not mutate files outside your claims. Do not run Git mutation, package installation, broad formatting, snapshot updates, or broad code generation unless every affected file is explicitly claimed.",
            "If another file is needed, contact the parent with kind=question, name the exact workspace-relative paths, and wait. Only a parent claim grant followed by its reply expands your scope. Peers cannot transfer claims.",
            "Report every changed file, validation command, and any possible out-of-claim side effect in the final report.",
          ].join("\n\n")
        : "You are the exclusive declared writer in the shared working directory. Keep edits narrowly within the assigned task and report changed files and validation."
      : "Your run is declared read-only as a prompt and writer-lease policy, not a tool-capability boundary. Inherited tools may still be capable of mutation; use them only for inspection and validation, and do not edit, write, patch, generate, or otherwise mutate project files. Use a writer assignment for intentional project changes.",
  ].join("\n\n");

export const taskPrompt = (request: StartSubagentRequest, peerNotice: string): string =>
  [`Assigned task:\n${request.task}`, `Workspace coordination:\n${peerNotice}`].join("\n\n");
