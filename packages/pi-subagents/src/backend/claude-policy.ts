// Pure Claude CLI policy: writer cwd rule grammar, fixed tool constants, strict sandbox
// settings, allowed-tool logic, and the Claude argv builders. This module imports no
// Effect and no Node process/filesystem APIs; platform cwd validation stays in the boundary
// path adapter, which passes its prevalidated policy result to these builders.
import type { SubagentEffort, SubagentWriteIntent } from "../domain/routing.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";

const MAX_CLAUDE_WRITER_CWD_CHARS = 4_096;
const UNSUPPORTED_CLAUDE_RULE_CHARACTERS = [
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
  "(",
  ")",
  "!",
  ",",
] as const;

export interface ClaudeWriterCwdPolicy {
  readonly cwd: string;
  readonly scopedEditRule: string;
}

/**
 * Build one cwd/rule pair only when the comma-delimited tool grammar can represent it. The
 * caller must already have platform-validated the cwd as a nonempty absolute path.
 */
export const claudeWriterCwdRulePolicy = (cwd: string): ClaudeWriterCwdPolicy | undefined => {
  if (
    cwd.length === 0 ||
    cwd.length > MAX_CLAUDE_WRITER_CWD_CHARS ||
    cwd.includes("\0") ||
    cwd.includes("\r") ||
    cwd.includes("\n") ||
    UNSUPPORTED_CLAUDE_RULE_CHARACTERS.some((character) => cwd.includes(character))
  )
    return undefined;
  return { cwd, scopedEditRule: `Edit(/${cwd}/**)` };
};

const SUPERVISOR_NATIVE_TOOLS = SUPERVISOR_MCP_TOOL_NAMES.map(
  (name) => `mcp__${SUPERVISOR_MCP_REGISTRATION}__${name}`,
);
export const CLAUDE_INSPECTION_TOOLS: ReadonlyArray<string> = [
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
  ...SUPERVISOR_NATIVE_TOOLS,
];
export const CLAUDE_NATIVE_AGENT_TOOLS: ReadonlyArray<string> = [
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
];
export const CLAUDE_READ_TOOLS: ReadonlyArray<string> = [
  "Bash",
  ...CLAUDE_INSPECTION_TOOLS,
  ...CLAUDE_NATIVE_AGENT_TOOLS,
];
export const CLAUDE_WRITE_TOOLS: ReadonlyArray<string> = [
  "Bash",
  "Edit",
  ...CLAUDE_INSPECTION_TOOLS,
  ...CLAUDE_NATIVE_AGENT_TOOLS,
];
export const CLAUDE_DENIED_TOOLS: ReadonlyArray<string> = [
  "Skill",
  "EnterWorktree",
  "ExitWorktree",
  "Chrome",
  "NotebookEdit",
  "Write",
];

/** The launch fields this pure policy reads; `BackendLaunchRequest` satisfies it structurally. */
export interface ClaudeLaunchPolicyRequest {
  readonly cwd: string;
  readonly writeIntent: SubagentWriteIntent;
  readonly model: string;
  readonly effort: SubagentEffort;
}

export const claudeAllowedTools = (
  writeIntent: SubagentWriteIntent,
  writerPolicy: ClaudeWriterCwdPolicy | undefined,
): ReadonlyArray<string> =>
  writeIntent === "writer" && writerPolicy
    ? [...CLAUDE_INSPECTION_TOOLS, writerPolicy.scopedEditRule, ...CLAUDE_NATIVE_AGENT_TOOLS]
    : [...CLAUDE_INSPECTION_TOOLS, ...CLAUDE_NATIVE_AGENT_TOOLS];

export interface ClaudePermissionSettings {
  readonly defaultMode: "dontAsk";
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
}

export interface ClaudeSandboxFilesystemSettings {
  readonly allowWrite: ReadonlyArray<string>;
  readonly denyWrite: ReadonlyArray<string>;
}

export interface ClaudeSandboxNetworkSettings {
  readonly allowedDomains: ReadonlyArray<string>;
  readonly strictAllowlist: true;
  readonly allowUnixSockets: ReadonlyArray<string>;
  readonly allowAllUnixSockets: false;
  readonly allowLocalBinding: false;
}

export interface ClaudeSandboxSettings {
  readonly enabled: true;
  readonly autoAllowBashIfSandboxed: true;
  readonly failIfUnavailable: true;
  readonly allowUnsandboxedCommands: false;
  readonly filesystem: ClaudeSandboxFilesystemSettings;
  readonly network: ClaudeSandboxNetworkSettings;
}

export interface ClaudeSettings {
  readonly permissions: ClaudePermissionSettings;
  readonly sandbox: ClaudeSandboxSettings;
  readonly crossSessionInbound: "refuse";
  readonly enableAllProjectMcpServers: false;
}

export const claudeSettings = (
  launch: ClaudeLaunchPolicyRequest,
  writerPolicy: ClaudeWriterCwdPolicy | undefined,
): ClaudeSettings => ({
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

export interface ClaudeHarnessPaths {
  readonly settingsPath: string;
  readonly mcpPath: string;
  readonly promptPath: string;
}

/** The policy flags shared by the local and Herdr Claude launches. */
export const claudePolicyArgv = (
  launch: ClaudeLaunchPolicyRequest,
  harness: ClaudeHarnessPaths,
  writerPolicy: ClaudeWriterCwdPolicy | undefined,
): ReadonlyArray<string> => [
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
  (launch.writeIntent === "writer" ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS).join(","),
  "--allowedTools",
  claudeAllowedTools(launch.writeIntent, writerPolicy).join(","),
  "--disallowedTools",
  CLAUDE_DENIED_TOOLS.join(","),
  "--system-prompt-file",
  harness.promptPath,
];

export const claudeArgv = (
  launch: ClaudeLaunchPolicyRequest,
  harness: ClaudeHarnessPaths,
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
  ...claudePolicyArgv(launch, harness, writerPolicy),
];
