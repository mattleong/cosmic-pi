export const SUPERVISOR_MCP_REGISTRATION = "pi_subagents_supervisor" as const;

export const SUPERVISOR_MCP_MESSAGE_TOOL_NAMES = [
  "supervisor_progress",
  "supervisor_warning",
  "supervisor_question",
] as const;
export const SUPERVISOR_MCP_AGENT_TOOL_NAMES = ["agent_list", "agent_send", "agent_read"] as const;
export const SUPERVISOR_MCP_TOOL_NAMES = [
  ...SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  "supervisor_submit_report",
  ...SUPERVISOR_MCP_AGENT_TOOL_NAMES,
] as const;
type SupervisorMcpToolName = (typeof SUPERVISOR_MCP_TOOL_NAMES)[number];
/** Tools that block on the parent, end the assignment, or speak for the run, so only the child's main agent may call them. */
export const SUPERVISOR_MCP_MAIN_AGENT_TOOL_NAMES = [
  "supervisor_question",
  "supervisor_submit_report",
  "agent_send",
] as const satisfies ReadonlyArray<SupervisorMcpToolName>;
export const NATIVE_SUB_AGENT_REFUSAL =
  "Only the main agent can ask the parent a question, message other agents, or submit the final report. You are a native sub-agent: return your findings to the agent that started you instead.";
export const SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS = ["message"] as const;
export const SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS = ["delivery_id", "report"] as const;
export const SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS = ["to", "message"] as const;
export const SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY = "ids" as const;

export const MAX_SUPERVISOR_MCP_MESSAGE_CHARS = 16_384;
export const MAX_SUPERVISOR_MCP_REPORT_CHARS = 32_768;
export const MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS = 256;
export const MAX_SUPERVISOR_MCP_THREAD_ID_CHARS = 256;
/** Matches the root's `agent_list` and `agent_read` target bound. */
export const MAX_SUPERVISOR_MCP_AGENT_IDS = 12;
export const MAX_SUPERVISOR_MCP_AGENT_ID_CHARS = 80;
export const SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE = ".*\\S.*";
export const SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";
/** Run IDs and `main`. */
export const SUPERVISOR_MCP_AGENT_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$";
