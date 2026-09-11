import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";
import type { McpManagerServer, McpManagerSnapshot } from "../manager/model.ts";
import { authExplanation, blockedExplanation } from "../manager/policy.ts";
import { discoveryNotices } from "../discovery/diagnostics.ts";

export const dashboardRows = (snapshot: McpManagerSnapshot, query: string) =>
  snapshot.servers.filter((row) =>
    `${row.id} ${row.scope} ${row.transport} ${row.state} ${row.auth}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
interface DashboardStatus {
  readonly label: string;
  readonly tone: "muted" | "warning" | "error" | "success";
}
const dashboardStatus = (row: McpManagerServer): DashboardStatus => {
  if (row.invalid) return { label: "Invalid config", tone: "error" };
  if (!row.enabled) return { label: "Disabled", tone: "muted" };
  switch (row.blockedReason) {
    case "cleanup-unconfirmed":
      return { label: "Cleanup unconfirmed", tone: "error" };
    case "cleanup-running":
      return { label: "Disconnecting", tone: "warning" };
    case "auth-running":
      return { label: "Signing in", tone: "warning" };
    case "auth-suspended":
      return { label: "Auth interrupted", tone: "warning" };
  }
  if (row.state === "connecting") return { label: "Connecting", tone: "warning" };
  if (row.state === "closing") return { label: "Disconnecting", tone: "warning" };
  if (row.state === "blocked") return { label: "Blocked", tone: "warning" };
  if (row.auth === "required") return { label: "Sign-in needed", tone: "warning" };
  if (row.auth === "unavailable") return { label: "Auth unavailable", tone: "warning" };
  return row.state === "connected"
    ? { label: "Connected", tone: "success" }
    : { label: "Not connected", tone: "muted" };
};

/** Shared column widths keep names and statuses aligned across scrolling and filtering. */
export const dashboardTable = (
  rows: ReadonlyArray<McpManagerServer>,
  width: number,
  theme: Theme,
) => {
  const scopeWidth = width >= 34 ? 7 : 0;
  const statusWidth =
    width >= 20
      ? Math.min(
          Math.max(13, ...rows.map((row) => visibleWidth(dashboardStatus(row).label))),
          width - 12 - (scopeWidth ? scopeWidth + 2 : 0),
        )
      : 0;
  const nameWidth = Math.max(
    0,
    Math.min(
      Math.max(18, ...rows.map((row) => visibleWidth(sanitizeTerminalLine(row.id)))),
      width - 2 - (scopeWidth ? scopeWidth + 2 : 0) - (statusWidth ? statusWidth + 2 : 0),
    ),
  );
  const cell = (value: string, size: number) =>
    padListDetailRow(truncateToWidth(value, size), size);
  const fields = (name: string, scope: string, status: string) =>
    `${name}${scopeWidth ? `  ${scope}` : ""}${statusWidth ? `  ${status}` : ""}`;
  return {
    header: theme.fg(
      "dim",
      `  ${fields(cell("Server", nameWidth), cell("Scope", scopeWidth), cell("Status", statusWidth))}`,
    ),
    row: (row: McpManagerServer, selected: boolean) => {
      const status = dashboardStatus(row);
      const name = cell(sanitizeTerminalLine(row.id), nameWidth);
      const line = padListDetailRow(
        `${selected ? theme.fg("accent", "> ") : "  "}${fields(
          selected ? theme.fg("accent", theme.bold(name)) : theme.fg("text", name),
          theme.fg("dim", cell(row.scope, scopeWidth)),
          theme.fg(status.tone, cell(status.label, statusWidth)),
        )}`,
        width,
      );
      return selected ? theme.bg("selectedBg", line) : line;
    },
  };
};
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
