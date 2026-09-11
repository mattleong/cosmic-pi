import { expect, it } from "vitest";
import type { McpCacheEvidence } from "../../src/discovery/cached.ts";
import { gatewayDiscoveryNotices } from "../../src/discovery/diagnostics.ts";

const snapshot = { server: "fixture", owner: "current-owner", diagnostics: [] };

it.each([
  { owner: "current-owner", state: "refresh-failed", expected: 1 },
  { owner: "previous-owner", state: "refresh-failed", expected: 0 },
  { owner: "current-owner", state: "refreshing", expected: 0 },
  { owner: "current-owner", state: "invalidated", expected: 0 },
] satisfies ReadonlyArray<McpCacheEvidence & { expected: number }>)(
  "reports failed refresh only for the selected snapshot owner: $owner / $state",
  ({ owner, state, expected }) => {
    const evidence = new Map([[snapshot.server, { owner, state }]]);
    expect(gatewayDiscoveryNotices([snapshot], evidence)).toHaveLength(expected);
    expect(gatewayDiscoveryNotices([], evidence)).toEqual([]);
  },
);

it("keeps unsupported-catalog diagnostics when refresh-failure evidence clears", () => {
  const metadata = {
    ...snapshot,
    diagnostics: [{ family: "prompts", reason: "rpc-method-not-found" }],
  } as const;
  const failed = gatewayDiscoveryNotices(
    [metadata],
    new Map([[snapshot.server, { owner: snapshot.owner, state: "refresh-failed" }]]),
  );
  const recovered = gatewayDiscoveryNotices([metadata], new Map());
  expect(failed).toHaveLength(2);
  expect(recovered).toHaveLength(1);
  expect(failed).toContain(recovered[0]);
});
