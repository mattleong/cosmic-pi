import { expect, it } from "vitest";
import type { McpCacheEvidence } from "../../src/discovery/cached.ts";
import {
  gatewayDiscoveryNotices,
  classifyMcpDiscoveryNotice,
} from "../../src/discovery/diagnostics.ts";

it("classifies exact producer notices by requested action without demoting unrelated recovery", () => {
  const notices = gatewayDiscoveryNotices(
    [
      {
        server: "catalog",
        owner: "owner",
        expiresAt: 0,
        diagnostics: [
          { family: "resources", reason: "rpc-method-not-found" },
          { family: "templates", reason: "rpc-method-not-found" },
        ],
      },
    ],
    new Map(),
  );
  for (const action of ["tools.list", "tools.search", "tools.describe"]) {
    for (const notice of notices) {
      const input = { action, outcome: "completed", isError: false, notice };
      expect(classifyMcpDiscoveryNotice(input).visibility).toBe("expanded-only");
      for (const changed of [
        { ...input, isError: true },
        { ...input, outcome: "unknown" },
        { ...input, action: "tools.call" },
        { ...input, action: "result.read" },
        { ...input, notice: `${notice} Check state first.` },
        { ...input, notice: notice.replace("catalog", "bad/server") },
      ])
        expect(classifyMcpDiscoveryNotice(changed).visibility).toBe("attention");
    }
  }
  for (const action of ["resources.list", "resources.templates"]) {
    for (const notice of notices.slice(1))
      expect(
        classifyMcpDiscoveryNotice({ action, outcome: "completed", isError: false, notice })
          .visibility,
      ).toBe("attention");
  }
  const important = gatewayDiscoveryNotices(
    [
      {
        server: "catalog",
        owner: "owner",
        expiresAt: 0,
        diagnostics: [
          { family: "tools", reason: "invalid-parameter-headers" },
          { family: "prompts", reason: "rpc-method-not-found" },
        ],
      },
    ],
    new Map([["catalog", { owner: "owner", state: "refresh-failed" }]]),
  );
  for (const notice of important)
    expect(
      classifyMcpDiscoveryNotice({
        action: "tools.search",
        outcome: "completed",
        isError: false,
        notice,
      }).visibility,
    ).toBe("attention");
});

const snapshot = { server: "fixture", owner: "current-owner", diagnostics: [], expiresAt: 60_000 };

it.each([
  { owner: "current-owner", state: "refresh-failed", expected: 1 },
  { owner: "previous-owner", state: "refresh-failed", expected: 0 },
  { owner: "current-owner", state: "refreshing", expected: 1 },
  { owner: "current-owner", state: "invalidated", expected: 1 },
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
