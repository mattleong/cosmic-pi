import type { ActivityItem } from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { mcpDiagnostic } from "../client/diagnostics.ts";
import type { McpBoundaryError } from "../client/errors.ts";

export type McpActivityOperation = "auth" | "connect" | "refresh";
export const MCP_ACTIVITY_PHASES = {
  starting: "Starting",
  "waiting-for-fence": "Waiting for connection cleanup",
  "checking-storage": "Checking secure storage",
  "preparing-callback": "Preparing callback listener",
  discovering: "Discovering authorization metadata",
  "preparing-client": "Preparing public client",
  "opening-browser": "Opening browser",
  "browser-approval": "Waiting for browser approval",
  "validating-callback": "Validating sign-in response",
  "exchanging-code": "Exchanging authorization code",
  "saving-credentials": "Saving credentials",
  finalizing: "Finalizing",
  connecting: "Connecting",
  refreshing: "Refreshing metadata",
  stopping: "Stopping and confirming cleanup",
} as const;
export type McpActivityPhase = keyof typeof MCP_ACTIVITY_PHASES;
export type McpActivityStatus =
  | "running"
  | "needs-input"
  | "stopping"
  | "done"
  | "failed"
  | "cancelled";
export interface McpActivityHandle {
  readonly id: string;
}
export interface McpActivityFailure {
  readonly kind?: McpBoundaryError["kind"];
  readonly reason?: McpBoundaryError["reason"];
}
export interface McpActivityEntry extends McpActivityHandle {
  readonly revision: string;
  readonly operation: McpActivityOperation;
  /** Configured server ID only. No endpoint, credential identity, or auth URL. */
  readonly server: string;
  readonly phase: McpActivityPhase;
  readonly status: McpActivityStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly endedAt?: number;
  readonly failure?: McpActivityFailure;
}
export interface McpStatusCounts {
  readonly connected: number;
  readonly active: number;
  readonly queued: number;
  readonly attention: number;
}
export const mcpActivityTerminal = (entry: McpActivityEntry): boolean =>
  entry.status === "done" || entry.status === "failed" || entry.status === "cancelled";

const operationLabel = {
  auth: "Sign in",
  connect: "Connect",
  refresh: "Refresh metadata",
} satisfies Record<McpActivityOperation, string>;
export const mcpActivityServerLabel = (server: string): string =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(server.slice(0, 128)), { maximumLength: 128 });

export const mcpActivityDetail = (entry: McpActivityEntry): string => {
  const lines = [
    `${operationLabel[entry.operation]}: ${mcpActivityServerLabel(entry.server)}`,
    mcpActivityTerminal(entry) ? entry.status : MCP_ACTIVITY_PHASES[entry.phase],
  ];
  if (entry.failure) {
    const evidence = { kind: entry.failure.kind ?? "unavailable", outcome: "not-sent" as const };
    const diagnostic = mcpDiagnostic(
      entry.failure.reason === undefined ? evidence : { ...evidence, reason: entry.failure.reason },
    );
    lines.push(diagnostic.title, diagnostic.explanation);
  }
  return lines.join("\n");
};

/** Plain Activity v1 data. The sole action opens an owned manager, never auth itself. */
export const projectMcpActivity = (entries: readonly McpActivityEntry[]): readonly ActivityItem[] =>
  entries.map((entry): ActivityItem => {
    const fields = {
      id: entry.id,
      revision: entry.revision,
      kind: "command" as const,
      title: `MCP ${operationLabel[entry.operation]}: ${mcpActivityServerLabel(entry.server)}`,
      summary: mcpActivityTerminal(entry) ? entry.status : MCP_ACTIVITY_PHASES[entry.phase],
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      endedAt: entry.endedAt,
      actions: [{ id: "inspect", label: "Open MCP details" }],
    };
    if (entry.status === "needs-input")
      return { ...fields, status: "needs-input", inputTarget: "user" };
    return { ...fields, status: entry.status };
  });

const safeCount = (value: number): number =>
  Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1_000_000) : 0;
export const mcpFooterStatus = (
  counts: McpStatusCounts,
  entries: readonly McpActivityEntry[],
  activityAvailable: boolean,
): string | undefined => {
  const pieces: string[] = [];
  const connected = safeCount(counts.connected);
  const active = safeCount(counts.active);
  const queued = safeCount(counts.queued);
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const attention = Math.max(safeCount(counts.attention), failed);
  if (connected) pieces.push(`${connected} connected`);
  if (active) pieces.push(`${active} active`);
  if (queued) pieces.push(`${queued} queued`);
  if (attention) pieces.push(`${attention} need attention`);
  if (!activityAvailable) {
    const running = entries.find((entry) => !mcpActivityTerminal(entry));
    if (running)
      pieces.push(
        `${mcpActivityServerLabel(running.server)}: ${MCP_ACTIVITY_PHASES[running.phase]}`,
      );
  }
  return pieces.length ? `MCP ${pieces.join(" · ")}` : undefined;
};
