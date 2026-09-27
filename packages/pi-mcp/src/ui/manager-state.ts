import type { McpCachedFamily } from "../discovery/model.ts";
import type { McpManagerAction, McpManagerServer } from "../manager/model.ts";

/** Only safe navigation state survives closing an owned overlay. Never metadata or result text. */
export interface McpManagerSelection {
  readonly screen: "dashboard" | "browse" | "result";
  readonly server: string | undefined;
  readonly family: McpCachedFamily;
  readonly query: string;
  readonly selected: string | undefined;
  readonly resultId: string | undefined;
}
export const managerSelection = (
  screen: McpManagerSelection["screen"] = "dashboard",
  server?: string,
  resultId?: string,
): McpManagerSelection => ({
  screen,
  server,
  family: "tools",
  query: "",
  selected: server,
  resultId,
});
export interface McpManagerClose {
  readonly selection: McpManagerSelection;
  readonly row: McpManagerServer;
  readonly action: McpManagerAction;
  /** The warning the person accepted on the screen, for actions that ask first. */
  readonly confirmed?: string | undefined;
}
