import type { McpMetadataSnapshot } from "./model.ts";

/** Only snapshot-owned fixed reasons enter notices, never remote error messages or metadata. */
export const discoveryNotices = (
  snapshots: ReadonlyArray<Pick<McpMetadataSnapshot, "server" | "diagnostics">>,
): ReadonlyArray<string> =>
  snapshots.flatMap((snapshot) =>
    snapshot.diagnostics.map(
      ({ family }) =>
        `MCP ${snapshot.server} ${family} catalog is unavailable because its listing method was not found.`,
    ),
  );
