import * as Arr from "effect/Array";
import type { SubagentEffort, SubagentWriteIntent } from "../domain/routing.ts";
import {
  NATIVE_SUB_AGENT_REFUSAL,
  SUPERVISOR_MCP_MAIN_AGENT_TOOL_NAMES,
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";

const MAX_CLAUDE_WRITER_CWD_CHARS = 4_096;
const UNSUPPORTED_CLAUDE_RULE_CHARACTERS = /[\0\r\n*?[\]{}()!,]/u;

export interface ClaudeWriterCwdPolicy {
  readonly cwd: string;
  readonly scopedEditRule: string;
}

export const claudeWriterCwdRulePolicy = (cwd: string): ClaudeWriterCwdPolicy | undefined =>
  cwd.length === 0 ||
  cwd.length > MAX_CLAUDE_WRITER_CWD_CHARS ||
  UNSUPPORTED_CLAUDE_RULE_CHARACTERS.test(cwd)
    ? undefined
    : { cwd, scopedEditRule: `Edit(/${cwd}/**)` };

const CLAUDE_INSPECTION_TOOLS: ReadonlyArray<string> = [
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
  ...Arr.map(SUPERVISOR_MCP_TOOL_NAMES, (name) => `mcp__${SUPERVISOR_MCP_REGISTRATION}__${name}`),
];
export const CLAUDE_NATIVE_AGENT_TOOLS: ReadonlyArray<string> = [
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
];
const CLAUDE_MAIN_AGENT_HOOK_ID = "pi-subagents-main-agent-tools";

/**
 * SDK hook callbacks sent with the initialize control request. Claude Code asks the driver before
 * each main-agent-only supervisor call and names a native sub-agent caller with `agent_id`.
 */
export const CLAUDE_HOOK_REGISTRATIONS = {
  PreToolUse: [
    {
      matcher: Arr.join(
        Arr.map(
          SUPERVISOR_MCP_MAIN_AGENT_TOOL_NAMES,
          (name) => `mcp__${SUPERVISOR_MCP_REGISTRATION}__${name}`,
        ),
        "|",
      ),
      hookCallbackIds: [CLAUDE_MAIN_AGENT_HOOK_ID],
    },
  ],
} as const;

export const claudeMainAgentToolDecision = (caller: "main" | "native-sub-agent") =>
  caller === "main"
    ? {}
    : {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: NATIVE_SUB_AGENT_REFUSAL,
        },
      };

const CLAUDE_DENIED_TOOLS: ReadonlyArray<string> = [
  "Skill",
  "EnterWorktree",
  "ExitWorktree",
  "Chrome",
  "NotebookEdit",
  "Write",
];

interface ClaudeLaunchPolicyRequest {
  readonly cwd: string;
  readonly writeIntent: SubagentWriteIntent;
  readonly model: string;
  readonly effort: SubagentEffort;
}

const claudeAllowedTools = (
  writeIntent: SubagentWriteIntent,
  writerPolicy: ClaudeWriterCwdPolicy | undefined,
): ReadonlyArray<string> => [
  ...CLAUDE_INSPECTION_TOOLS,
  ...(writeIntent === "writer" && writerPolicy ? [writerPolicy.scopedEditRule] : []),
  ...CLAUDE_NATIVE_AGENT_TOOLS,
];

/**
 * `sharedTemporaryDirectory` is Claude Code's per-user temp directory. Each child has a private
 * one, but sandboxed Bash falls back to the shared one when the private path is too long, so
 * denying it makes that fallback fail closed rather than write where other sessions read.
 */
export const claudeSettings = (
  launch: ClaudeLaunchPolicyRequest,
  writerPolicy: ClaudeWriterCwdPolicy | undefined,
  sharedTemporaryDirectory: string,
) => ({
  permissions: {
    defaultMode: "dontAsk",
    allow: claudeAllowedTools(launch.writeIntent, writerPolicy),
    deny: CLAUDE_DENIED_TOOLS,
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: launch.writeIntent === "writer" && writerPolicy ? [writerPolicy.cwd] : [],
      denyWrite: [
        ...(launch.writeIntent === "read-only" ? [launch.cwd] : []),
        sharedTemporaryDirectory,
      ],
    },
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
  },
  crossSessionInbound: "refuse",
  enableAllProjectMcpServers: false,
});

export const claudeArgv = (
  launch: ClaudeLaunchPolicyRequest,
  harness: { readonly settingsPath: string; readonly mcpPath: string; readonly promptPath: string },
  writerPolicy: ClaudeWriterCwdPolicy | undefined,
): ReadonlyArray<string> => [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--no-session-persistence",
  "--model",
  launch.model,
  "--effort",
  launch.effort,
  "--disable-slash-commands",
  "--no-chrome",
  "--setting-sources",
  "",
  "--settings",
  harness.settingsPath,
  "--strict-mcp-config",
  "--mcp-config",
  harness.mcpPath,
  "--permission-mode",
  "dontAsk",
  "--tools",
  Arr.join(
    [
      "Bash",
      ...(launch.writeIntent === "writer" ? ["Edit"] : []),
      ...CLAUDE_INSPECTION_TOOLS,
      ...CLAUDE_NATIVE_AGENT_TOOLS,
    ],
    ",",
  ),
  "--allowedTools",
  Arr.join(claudeAllowedTools(launch.writeIntent, writerPolicy), ","),
  "--disallowedTools",
  Arr.join(CLAUDE_DENIED_TOOLS, ","),
  "--append-system-prompt-file",
  harness.promptPath,
];
