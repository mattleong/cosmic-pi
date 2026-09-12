import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";
import { detailFieldRows, listDetailHeading } from "pi-cosmic-ui/manager/list-detail-shell";
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
      return { label: "Disconnecting", tone: "muted" };
    case "auth-running":
      return { label: "Signing in", tone: "muted" };
    case "auth-suspended":
      return { label: "Auth interrupted", tone: "warning" };
  }
  if (row.state === "connecting") return { label: "Connecting", tone: "muted" };
  if (row.state === "closing") return { label: "Disconnecting", tone: "muted" };
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
  focused: boolean,
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
    header: listDetailHeading(
      theme,
      fields(cell("Server", nameWidth), cell("Scope", scopeWidth), cell("Status", statusWidth)),
      focused,
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
const metadataExplanation = (row: McpManagerServer): string => {
  const summary = row.metadata
    ? `${row.metadata.support.tools ? `${row.metadata.tools} tools` : "Tools unavailable"} · ${row.metadata.resources} resources · ${row.metadata.templates} templates · ${row.metadata.prompts} prompts`
    : undefined;
  switch (row.metadataState) {
    case "unavailable":
      return "Unavailable";
    case "checking":
      return "Checking cached metadata";
    case "undiscovered":
      return row.actions.some((choice) => choice.action === "refresh" && choice.enabled)
        ? "Discover metadata to load tools"
        : "Not discovered";
    case "invalidated":
      return "Cached metadata withdrawn. Discover again when ready.";
    case "refreshing":
      return summary ? `${summary} · refreshing` : "Discovering metadata";
    case "refresh-failed":
      return summary ? `${summary} · refresh failed` : "Discovery failed. Retry from Actions.";
    case "stale":
      return summary ? `${summary} · stale, inspection only` : "Cached metadata is not fresh.";
    case "unsupported":
      return summary ?? "Tools catalog unavailable";
    case "empty":
    case "ready":
      return summary ?? "Cached metadata unavailable";
  }
};

export const dashboardDetail = (
  row: McpManagerServer | undefined,
  theme: Theme,
  focused: boolean,
): ReadonlyArray<string> => {
  if (!row) return [theme.fg("muted", "No server selected.")];
  const status = dashboardStatus(row);
  const notices = [
    ...(row.diagnostic ? [theme.fg("error", sanitizeTerminalLine(row.diagnostic))] : []),
    ...(row.blockedReason ? [theme.fg(status.tone, blockedExplanation(row.blockedReason))] : []),
    ...discoveryNotices(row.metadata ? [row.metadata] : []).map((notice) =>
      theme.fg("warning", sanitizeTerminalLine(notice)),
    ),
  ];
  return [
    listDetailHeading(theme, sanitizeTerminalLine(row.id), focused),
    theme.fg(
      "dim",
      row.transport === "invalid" ? row.scope : `${row.scope} · ${row.transport.toUpperCase()}`,
    ),
    "",
    ...detailFieldRows(theme, [
      {
        label: "Status",
        value: status.label,
        tone: status.tone === "muted" ? "text" : status.tone,
      },
      { label: "Auth", value: row.invalid ? "Not evaluated" : authExplanation(row) },
      { label: "Metadata", value: metadataExplanation(row) },
      ...(row.active || row.queued
        ? [{ label: "Activity", value: `${row.active} active · ${row.queued} queued` }]
        : []),
    ]),
    ...(notices.length ? ["", ...notices] : []),
  ];
};
