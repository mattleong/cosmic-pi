import type { McpGatewayRequest } from "./model.ts";

/** Owned contract guidance only. Never interpolate rejected values or property names. */
const requirements = {
  status: 'Status accepts only action. Remove server and other fields; use { "action": "status" }.',
  connect: "connect requires server and accepts no other fields besides action.",
  disconnect: "disconnect requires server and accepts no other fields besides action.",
  refresh: "refresh requires server and accepts no other fields besides action.",
  "server.instructions":
    "server.instructions requires server and accepts no other fields besides action.",
  "tools.list": "tools.list accepts optional server, cursor, and limit from 1 to 100.",
  "tools.search":
    "tools.search requires query, at most 1024 characters. Optional fields: server, cursor, and limit from 1 to 100.",
  "tools.describe":
    "tools.describe requires server and tool. No other fields besides action are accepted.",
  "tools.call":
    "tools.call requires server and tool. Optional fields: object arguments and logLevel. Describe the tool before constructing arguments.",
  "resources.list":
    "resources.list requires server. Optional fields: cursor and limit from 1 to 100.",
  "resources.templates":
    "resources.templates requires server. Optional fields: cursor and limit from 1 to 100.",
  "resources.read": "resources.read requires server and uri. Only logLevel is optional.",
  "resources.subscribe":
    "resources.subscribe requires server and uri. No other fields besides action are accepted.",
  "resources.unsubscribe":
    "resources.unsubscribe requires server and uri. No other fields besides action are accepted.",
  "resources.subscriptions":
    "resources.subscriptions requires server and accepts no other fields besides action.",
  "prompts.list": "prompts.list requires server. Optional fields: cursor and limit from 1 to 100.",
  "prompts.get":
    "prompts.get requires server and prompt. Optional fields: string-valued arguments and logLevel. Use prompts.list to inspect declared arguments.",
  "completion.complete":
    "completion.complete requires server, ref, and argument. Optional fields: context and logLevel. Use an advertised prompt name or resource-template URI and string argument name/value.",
  "events.read":
    "events.read requires server. Optional fields: string cursor and limit from 1 to 100. Use the returned cursor, not a numeric offset.",
  "result.read":
    "result.read requires id, not server. Optional offset and attachment must be nonnegative integers; limit must be an integer from 1 to 50000. Follow the returned next offset.",
} satisfies Record<McpGatewayRequest["action"], string>;

export const mcpRequestGuidance = (action: string | undefined): string => {
  const entry = Object.entries(requirements).find(([name]) => name === action);
  return entry === undefined
    ? "Use a supported MCP action and only its declared fields. Omit action for status, which accepts no other fields."
    : entry[1];
};
