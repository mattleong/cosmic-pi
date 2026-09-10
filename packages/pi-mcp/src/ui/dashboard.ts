import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { McpManagerServer, McpManagerSnapshot } from "../manager/model.ts";
import { authExplanation, blockedExplanation } from "../manager/policy.ts";
import { discoveryNotices } from "../discovery/diagnostics.ts";

export const dashboardRows = (snapshot: McpManagerSnapshot, query: string) =>
  snapshot.servers.filter((row) =>
    `${row.id} ${row.scope} ${row.transport} ${row.state} ${row.auth}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
export const dashboardLabel = (row: McpManagerServer) =>
  `${sanitizeTerminalLine(row.id)}  ${row.scope} ${row.transport}  ${row.invalid ? "invalid" : !row.enabled ? "disabled" : row.state} / ${row.auth}`;
export const dashboardDetail = (row: McpManagerServer | undefined): ReadonlyArray<string> => {
  if (!row) return ["No server selected."];
  return [
    sanitizeTerminalLine(row.id),
    `${row.scope} / ${row.transport}`,
    authExplanation(row),
    `Connection: ${row.state}`,
    `Active ${row.active} / queued ${row.queued}`,
    ...(row.blockedReason ? [blockedExplanation(row.blockedReason)] : []),
    row.metadata
      ? `Cached tools ${row.metadata.tools}, resources ${row.metadata.resources}, templates ${row.metadata.templates}, prompts ${row.metadata.prompts}`
      : "Metadata not discovered or withdrawn.",
    ...discoveryNotices(row.metadata ? [row.metadata] : []),
    "",
    "Connect does not discover metadata, start sign-in, or prove remote health.",
    ...row.actions.map(
      (choice) => `${choice.label}${choice.reason ? `: ${blockedExplanation(choice.reason)}` : ""}`,
    ),
  ];
};
