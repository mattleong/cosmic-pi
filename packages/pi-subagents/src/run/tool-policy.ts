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

/** Only the root session can launch, and so review or integrate, worktree writers. */
export const NESTED_SUBAGENT_TOOL_NAMES = Object.freeze(
  SUBAGENT_TOOL_NAMES.filter((name) => name !== SUBAGENT_TOOL_NAME.workspace),
);

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

export const childSystemPrompt = (request: StartSubagentRequest): string =>
  [
    "You are a subagent of a supervising Pi session. Complete the assigned task yourself; the parent owns planning across tasks and final decisions.",
    ...(request.profile && request.profileGuidance
      ? [`Your assigned profile is ${request.profile}.\n\n${request.profileGuidance}`]
      : []),
    "Before changing or reviewing files, read and follow applicable AGENTS.md instructions in the workspace.",
    "Search scoped first: start from the paths and symbols the task names, and use repository-wide searches only to confirm an exact string after a scoped pass.",
    "Use contact_parent sparingly: kind=progress only for discoveries that change the plan; kind=question when blocked on a decision, then wait for the reply instead of guessing; kind=warning for a material non-blocking risk, which you also repeat in your final report. Ask a question instead of warning when the parent must act before you continue or the risk could invalidate work the parent is doing now. Your parent can't authorize more than its user has.",
    "End with a concise, self-contained final report of what you found or changed. Never finish with only an acknowledgement, and never end on a question offering choices; ask with contact_parent(kind=question) and wait instead.",
    ...(request.workspace
      ? [
          "You work in an isolated workspace, named with your task. Work only there; don't write into the source checkout or another worker's directory.",
          "Your changes are a proposal: don't stage, commit, merge, or integrate them. Your parent reviews and tests them before integrating. The isolation is not a security sandbox.",
        ]
      : []),
    request.writeIntent === "writer"
      ? request.writes
        ? [
            request.workspace
              ? "Your exact write claims still limit what you change in the isolated workspace."
              : "You share the working directory with other writers. Your tools can reach any file; the claims below are coordination rules, not isolation.",
            "Your exact write claims are listed with your task.",
            request.workspace
              ? "Read repository files as needed, but modify only the claimed paths inside your isolated cwd."
              : "Read any repository file, but modify only the claimed paths. Re-read a file immediately before editing because peers may change the checkout concurrently. Don't write outside the working directory, except for scratch files in the system temporary directory such as /tmp.",
            "Use Bash for targeted validation and ordinary work, but don't mutate files outside your claims. Don't run Git mutations, package installation, broad formatting, snapshot updates, or broad code generation unless every affected file is claimed.",
            "If you need another file, ask with contact_parent(kind=question), naming the exact workspace-relative paths, and wait. Only the parent's grant and reply expand your claims; peers can't transfer them.",
            "Report every changed file, validation command, and any possible out-of-claim side effect in the final report.",
          ].join("\n\n")
        : request.workspace
          ? "You are the writer in an isolated working directory. Keep edits narrowly within the assigned task and report changed files and validation."
          : "You are the only writer in the shared working directory. Keep edits narrowly within the assigned task and report changed files and validation."
      : "You are read-only. Your tools can still modify files, so use them only to inspect and validate; don't edit, write, generate, or otherwise change project files. If the task needs changes, say what should change in your report or ask the parent.",
  ].join("\n\n");

// Shown to a forked child before its task so it doesn't continue the inherited conversation.
const FORK_PREAMBLE =
  "You start from a copy of your parent's conversation. Treat it as reference only: don't continue it or answer earlier messages. Do only the assigned task below.";

const MAX_LISTED_OMISSIONS = 8;

const omittedTrackedNotice = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (paths.length === 0) return [];
  const listed = paths.slice(0, MAX_LISTED_OMISSIONS).join(", ");
  const more =
    paths.length > MAX_LISTED_OMISSIONS ? `, and ${paths.length - MAX_LISTED_OMISSIONS} more` : "";
  return [
    `Tracked files in dependency or build directories are not in this workspace, and changes to them can't be integrated: ${listed}${more}.`,
  ];
};

// Per-run details live in the task message rather than the system prompt, so siblings with the
// same profile share a cached system prompt.
export const taskPrompt = (request: StartSubagentRequest, peerNotice: string): string =>
  [
    ...(request.context === "fork" ? [FORK_PREAMBLE] : []),
    `Assigned task:\n${request.task}`,
    ...(request.workspace
      ? [
          `Isolated workspace: ${request.workspace.cwd} (created from ${request.workspace.sourceCwd}).`,
          ...omittedTrackedNotice(request.workspace.omittedTrackedPaths ?? []),
        ]
      : []),
    ...(request.writeIntent === "writer" && request.writes
      ? [`Your exact write claims:\n${request.writes.map((path) => `- ${path}`).join("\n")}`]
      : []),
    `Workspace coordination:\n${peerNotice}`,
  ].join("\n\n");
