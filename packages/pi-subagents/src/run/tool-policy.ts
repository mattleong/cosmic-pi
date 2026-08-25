import * as Effect from "effect/Effect";
import type { SubagentWriteIntent } from "../domain/routing.ts";
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

/**
 * Orchestration tools a child must never receive.
 *
 * Applied twice on purpose: the tool resolves the parent's active tools against it, and the child
 * process boundary passes it again as `--exclude-tools`.
 */
export const ORCHESTRATION_TOOL_DENYLIST: ReadonlySet<string> = new Set([
  ...SUBAGENT_TOOL_NAMES,
  "herdr_agent_start",
  "herdr_agent_list",
  "herdr_agent_status",
  "herdr_agent_await",
  "herdr_agent_read",
  "herdr_agent_send",
  "herdr_agent_stop",
  "workflow",
  "workflow_control",
]);

export const ORCHESTRATION_TOOL_DENYLIST_ARGUMENT = [...ORCHESTRATION_TOOL_DENYLIST].join(",");

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

const PI_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "web_search",
  "fetch_content",
  "get_search_content",
]);

export const piToolsForWriteIntent = (
  activeTools: ReadonlyArray<string>,
  writeIntent: SubagentWriteIntent,
): ReadonlyArray<string> =>
  [...new Set(activeTools)].filter(
    (tool) => writeIntent === "writer" || PI_READ_ONLY_TOOLS.has(tool),
  );

export const childSystemPrompt = (request: StartSubagentRequest): string =>
  [
    "You are a subagent working for a supervising Pi session.",
    "Complete the assigned task directly. The parent owns orchestration, task partitioning, and final decisions.",
    "Do not launch or propose additional subagents.",
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
      : "Your run is declared read-only. When Bash is available, use it for inspection and validation only; do not use it to edit, write, patch, generate, or otherwise mutate project files. Use a writer assignment for intentional project changes.",
  ].join("\n\n");

export const taskPrompt = (request: StartSubagentRequest, peerNotice: string): string =>
  [`Assigned task:\n${request.task}`, `Workspace coordination:\n${peerNotice}`].join("\n\n");
