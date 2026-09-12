import type { McpMetadataSnapshot } from "./model.ts";
import type { McpCacheEvidence } from "./cached.ts";
import { metadataIsFresh } from "./freshness.ts";

/** Only snapshot-owned fixed reasons enter notices, never remote error messages or metadata. */
export const discoveryNotices = (
  snapshots: ReadonlyArray<Pick<McpMetadataSnapshot, "server" | "diagnostics">>,
): ReadonlyArray<string> =>
  snapshots.flatMap((snapshot) =>
    snapshot.diagnostics.map(({ family, reason }) =>
      reason === "invalid-parameter-headers"
        ? `MCP ${snapshot.server} excluded tools with invalid parameter-header definitions.`
        : `MCP ${snapshot.server} ${family} catalog is unavailable because its listing method was not found.`,
    ),
  );

/** Call with snapshots and evidence captured together under the discovery state lock. */
export const gatewayDiscoveryNotices = (
  snapshots: ReadonlyArray<
    Pick<McpMetadataSnapshot, "server" | "owner" | "diagnostics" | "expiresAt">
  >,
  evidence: ReadonlyMap<string, McpCacheEvidence>,
  now = 0,
): ReadonlyArray<string> => [
  ...snapshots.flatMap((snapshot) => {
    const observed = evidence.get(snapshot.server);
    if (observed?.owner === snapshot.owner && observed.state === "refresh-failed")
      return [
        `MCP ${snapshot.server} metadata refresh failed; previous metadata is a stale inspection-only view.`,
      ];
    return !metadataIsFresh(snapshot, now) || observed?.owner === snapshot.owner
      ? [
          `MCP ${snapshot.server} cached metadata is not fresh; invocation requires current metadata.`,
        ]
      : [];
  }),
  ...discoveryNotices(snapshots),
];
