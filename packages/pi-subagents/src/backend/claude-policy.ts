// Pure Claude CLI policy: writer cwd rule grammar, fixed tool constants, strict sandbox
// settings, allowed-tool logic, and the Claude argv builder. This module imports no
// Effect and no Node process/filesystem APIs; platform cwd validation stays in the boundary
// path adapter, which passes its prevalidated policy result to these builders.
import type { SubagentEffort, SubagentWriteIntent } from "../domain/routing.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";

const MAX_CLAUDE_WRITER_CWD_CHARS = 4_096;
/** Line and NUL characters plus the rule grammar's glob, group, negation, and list syntax. */
const UNSUPPORTED_CLAUDE_RULE_CHARACTERS = /[\0\r\n*?[\]{}()!,]/u;

export interface ClaudeWriterCwdPolicy {
  readonly cwd: string;
  readonly scopedEditRule: string;
}

/**
 * Build one cwd/rule pair only when the comma-delimited tool grammar can represent it. The
 * caller must already have platform-validated the cwd as a nonempty absolute path.
 */
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
  ...SUPERVISOR_MCP_TOOL_NAMES.map((name) => `mcp__${SUPERVISOR_MCP_REGISTRATION}__${name}`),
];
export const CLAUDE_NATIVE_AGENT_TOOLS: ReadonlyArray<string> = [
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
];
const CLAUDE_DENIED_TOOLS: ReadonlyArray<string> = [
  "Skill",
  "EnterWorktree",
  "ExitWorktree",
  "Chrome",
  "NotebookEdit",
  "Write",
];

/** The launch fields this pure policy reads; `BackendLaunchRequest` satisfies it structurally. */
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

export const claudeSettings = (
  launch: ClaudeLaunchPolicyRequest,
  writerPolicy: ClaudeWriterCwdPolicy | undefined,
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
      denyWrite: launch.writeIntent === "read-only" ? [launch.cwd] : [],
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
  [
    "Bash",
    ...(launch.writeIntent === "writer" ? ["Edit"] : []),
    ...CLAUDE_INSPECTION_TOOLS,
    ...CLAUDE_NATIVE_AGENT_TOOLS,
  ].join(","),
  "--allowedTools",
  claudeAllowedTools(launch.writeIntent, writerPolicy).join(","),
  "--disallowedTools",
  CLAUDE_DENIED_TOOLS.join(","),
  "--system-prompt-file",
  harness.promptPath,
];
