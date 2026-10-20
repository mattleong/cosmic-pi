import { AGENT_TOOL_NAME, AGENT_TOOL_NAMES, CONTACT_PARENT_TOOL_NAME } from "../run/tool-policy.ts";

export const SUPERVISOR_MCP_REGISTRATION = "pi_subagents_supervisor" as const;

export const SUPERVISOR_MCP_REPORT_TOOL_NAME = "agent_submit_report";
/** A Pi child's own contact tool and the agent tools, plus the report tool Pi children don't need. */
export const SUPERVISOR_MCP_TOOL_NAMES = [
  CONTACT_PARENT_TOOL_NAME,
  SUPERVISOR_MCP_REPORT_TOOL_NAME,
  ...AGENT_TOOL_NAMES,
] as const;
type SupervisorMcpToolName = (typeof SUPERVISOR_MCP_TOOL_NAMES)[number];
/** Tools that reach the parent, end the assignment, or speak for the run, so only the child's main agent may call them. */
export const SUPERVISOR_MCP_MAIN_AGENT_TOOL_NAMES = [
  CONTACT_PARENT_TOOL_NAME,
  SUPERVISOR_MCP_REPORT_TOOL_NAME,
  AGENT_TOOL_NAME.send,
] as const satisfies ReadonlyArray<SupervisorMcpToolName>;
export const NATIVE_SUB_AGENT_REFUSAL =
  "Only the main agent can contact the parent, message other agents, or submit the final report. You are a native sub-agent: return your findings to the agent that started you instead.";
export const SUPERVISOR_MCP_CONTACT_KINDS = ["progress", "warning", "question"] as const;
export const SUPERVISOR_MCP_CONTACT_ARGUMENT_KEYS = ["kind", "message"] as const;
export const SUPERVISOR_MCP_REPORT_ARGUMENT_KEYS = ["delivery_id", "report"] as const;
export const SUPERVISOR_MCP_AGENT_SEND_ARGUMENT_KEYS = ["to", "message"] as const;
export const SUPERVISOR_MCP_AGENT_IDS_ARGUMENT_KEY = "agentIds" as const;
export const SUPERVISOR_MCP_VERBOSE_ARGUMENT_KEY = "verbose" as const;

export const MAX_SUPERVISOR_MCP_MESSAGE_CHARS = 16_384;
/**
 * A submitted report travels as JSON, which can spend six bytes on one character (`\u0001`), on two
 * bounded lines: the 3 MiB supervisor channel line, and the 4 MiB CLI stdout line, because Claude
 * stream-json and Codex item arguments echo the submission. This cap fits the smaller with room for
 * the envelope, below the 1 MiB archive cap.
 */
export const MAX_SUPERVISOR_MCP_REPORT_CHARS = 480 * 1024;
export const MAX_SUPERVISOR_MCP_DELIVERY_ID_CHARS = 256;
export const MAX_SUPERVISOR_MCP_THREAD_ID_CHARS = 256;
/** Matches the root's `agent_list` and `agent_read` target bound. */
export const MAX_SUPERVISOR_MCP_AGENT_IDS = 12;
export const MAX_SUPERVISOR_MCP_AGENT_ID_CHARS = 80;
/** Unanchored, so a check stays linear even on a long blank line. */
export const SUPERVISOR_MCP_NONBLANK_PATTERN_SOURCE = "\\S";
export const SUPERVISOR_MCP_DELIVERY_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$";
/** Run IDs and `main`. */
export const SUPERVISOR_MCP_AGENT_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$";
