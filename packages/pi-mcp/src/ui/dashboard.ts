import type { Theme } from "@earendil-works/pi-coding-agent";
import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";
import { managerTable } from "pi-cosmic-ui/manager/table";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";
import { detailFieldRows, listDetailHeading } from "pi-cosmic-ui/manager/list-detail-shell";
import type { McpManagerServer, McpManagerSnapshot } from "../manager/model.ts";
import { authExplanation, blockedExplanation, blockedLabel } from "../manager/policy.ts";
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
const blockedTone = {
  "cleanup-unconfirmed": "error",
  "cleanup-running": "muted",
  "auth-running": "muted",
  "auth-suspended": "warning",
} satisfies Record<NonNullable<McpManagerServer["blockedReason"]>, DashboardStatus["tone"]>;
const dashboardStatus = (row: McpManagerServer): DashboardStatus => {
  if (row.invalid) return { label: "Invalid config", tone: "error" };
  if (!row.enabled) return { label: "Disabled", tone: "muted" };
  const blocked = row.blockedReason;
  if (blocked) return { label: blockedLabel[blocked], tone: blockedTone[blocked] };
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
  const table = managerTable(
    [
      ["Server", "Scope", "Status"],
      ...rows.map((row) => [sanitizeTerminalLine(row.id), row.scope, dashboardStatus(row).label]),
    ],
    [
      { minWidth: 8, priority: 3 },
      { minWidth: 7, priority: 1 },
      { minWidth: 13, priority: 2 },
    ],
    width - 2,
  );
  return {
    header: listDetailHeading(theme, table.row(["Server", "Scope", "Status"]), focused),
    row: (row: McpManagerServer, selected: boolean) => {
      const status = dashboardStatus(row);
      const name = table.cell(sanitizeTerminalLine(row.id), 0);
      const line = padListDetailRow(
        `${selected ? theme.fg(focused ? "accent" : "muted", "> ") : "  "}${table.row([
          selected && focused ? focusedField(theme, name) : theme.fg(managerTone.identity, name),
          theme.fg(managerTone.saved, row.scope),
          theme.fg(status.tone, status.label),
        ])}`,
        width,
      );
      return selected && focused ? theme.bg("selectedBg", line) : line;
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
    listDetailHeading(theme, sanitizeTerminalLine(row.id), focused, managerTone.identity),
    theme.fg(
      managerTone.saved,
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
