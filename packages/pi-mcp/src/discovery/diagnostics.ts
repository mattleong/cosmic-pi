import type { McpMetadataSnapshot } from "./model.ts";
import type { McpCacheEvidence } from "./cached.ts";

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

/** Call with snapshots and evidence captured together under the discovery state lock. */
export const gatewayDiscoveryNotices = (
  snapshots: ReadonlyArray<Pick<McpMetadataSnapshot, "server" | "owner" | "diagnostics">>,
  evidence: ReadonlyMap<string, McpCacheEvidence>,
): ReadonlyArray<string> => [
  ...snapshots.flatMap((snapshot) => {
    const observed = evidence.get(snapshot.server);
    return observed?.owner === snapshot.owner && observed.state === "refresh-failed"
      ? [`MCP ${snapshot.server} metadata refresh failed; using the previous cached metadata.`]
      : [];
  }),
  ...discoveryNotices(snapshots),
];
