export const SUPERVISOR_MCP_REGISTRATION = "pi_subagents_supervisor" as const;

export const SUPERVISOR_MCP_MESSAGE_TOOL_NAMES = [
  "supervisor_progress",
  "supervisor_warning",
  "supervisor_question",
] as const;
export const SUPERVISOR_MCP_TOOL_NAMES = [
  ...SUPERVISOR_MCP_MESSAGE_TOOL_NAMES,
  "supervisor_submit_report",
] as const;
export const SUPERVISOR_MCP_MESSAGE_ARGUMENT_KEYS = ["message"] as const;
export const SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS = ["delivery_id", "report"] as const;

export const MAX_SUPERVISOR_MCP_MESSAGE_CHARS = 16_384;
export const MAX_SUPERVISOR_MCP_REPORT_CHARS = 32_768;
export const MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS = 256;
export const SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE = ".*\\S.*";
export const SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";
