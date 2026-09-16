import * as Schema from "effect/Schema";
import { McpServerIdSchema } from "../config/schema.ts";
import type { McpMetadataSnapshot } from "./model.ts";
import type { McpCacheEvidence } from "./cached.ts";
import { metadataIsFresh } from "./freshness.ts";

const staleNotice = (server: string) =>
  `MCP ${server} cached metadata is not fresh; invocation requires current metadata.`;
const unsupportedNotice = (server: string, family: string) =>
  `MCP ${server} ${family} catalog is unavailable because its listing method was not found.`;

export interface McpDiscoveryNoticePolicy {
  readonly visibility: "attention" | "expanded-only";
  readonly reason?: "cache-not-fresh" | "optional-catalog";
  readonly scope?: "metadata" | "resources" | "templates";
}

/** Only successful local discovery can identify these exact gateway-authored notices.
 * Unknown, remote, failed-refresh and requested-catalog diagnostics remain attention. */
export function classifyMcpDiscoveryNotice(input: {
  readonly action: string;
  readonly outcome: string;
  readonly isError: boolean;
  readonly notice: string;
}): McpDiscoveryNoticePolicy {
  const attention: McpDiscoveryNoticePolicy = { visibility: "attention" };
  if (
    input.outcome !== "completed" ||
    input.isError ||
    ![
      "tools.list",
      "tools.search",
      "tools.describe",
      "resources.list",
      "resources.templates",
      "prompts.list",
    ].includes(input.action)
  )
    return attention;
  const server = /^MCP ([^ ]+) /u.exec(input.notice)?.[1];
  if (!Schema.is(McpServerIdSchema)(server)) return attention;
  if (input.notice === staleNotice(server))
    return { visibility: "expanded-only", reason: "cache-not-fresh", scope: "metadata" };
  if (["tools.list", "tools.search", "tools.describe"].includes(input.action)) {
    for (const family of ["resources", "templates"] as const)
      if (input.notice === unsupportedNotice(server, family))
        return { visibility: "expanded-only", reason: "optional-catalog", scope: family };
  }
  return attention;
}

export const mcpUndiscoveredNotice = (count: number): string =>
  `Discovery is incomplete: ${count} undiscovered servers. Select a server for a targeted list or search.`;

/** Only snapshot-owned fixed reasons enter notices, never remote error messages or metadata. */
export const discoveryNotices = (
  snapshots: ReadonlyArray<Pick<McpMetadataSnapshot, "server" | "diagnostics">>,
): ReadonlyArray<string> =>
  snapshots.flatMap((snapshot) =>
    snapshot.diagnostics.map(({ family, reason }) =>
      reason === "invalid-parameter-headers"
        ? `MCP ${snapshot.server} excluded tools with invalid parameter-header definitions.`
        : unsupportedNotice(snapshot.server, family),
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
      ? [staleNotice(snapshot.server)]
      : [];
  }),
  ...discoveryNotices(snapshots),
];
