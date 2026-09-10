import { expect, it } from "vitest";
import type { McpResolvedConfig } from "../../src/config/model.ts";
import { DEFAULT_MCP_SETTINGS } from "../../src/config/schema.ts";
import { describeCached, queryCached } from "../../src/discovery/cached.ts";
import type { McpMetadataSnapshot } from "../../src/discovery/model.ts";
import { emptyCursorState } from "../../src/discovery/pagination.ts";

const config: McpResolvedConfig = {
  revision: 1,
  trusted: true,
  settings: { ...DEFAULT_MCP_SETTINGS, enabled: true },
  diagnostics: [],
  servers: {
    a: {
      id: "a",
      identity: "identity",
      directory: "/private",
      enabled: true,
      scope: "global",
      definition: {
        transport: "stdio",
        command: "private",
        args: [],
        environment: {},
        denyTools: ["denied"],
      },
    },
  },
};
const snapshot: McpMetadataSnapshot = {
  server: "a",
  owner: "owner",
  identity: "identity",
  configRevision: 1,
  revision: 2,
  support: { tools: true, resources: false, templates: false, prompts: true },
  diagnostics: [],
  tools: [
    ...Array.from({ length: 150 }, (_, index) => ({
      name: `tool-${index}`,
      description: index === 149 ? "needle" : "ordinary",
      inputSchema: {},
    })),
    { name: "denied", inputSchema: {} },
  ],
  resources: [],
  templates: [],
  prompts: [{ name: "prompt", arguments: [{ name: "arg", required: true }] }],
};
const snapshots = new Map([["a", snapshot]]);
it("family diagnostics follow the visible snapshot and retain refresh-state precedence", () => {
  const partial: McpMetadataSnapshot = {
    ...snapshot,
    diagnostics: [{ family: "resources", reason: "rpc-method-not-found" }],
  };
  const stored = new Map([["a", partial]]);
  const resources = queryCached(
    { family: "resources" },
    config,
    stored,
    new Map(),
    emptyCursorState(),
    "test",
  );
  expect(resources.page.catalogs[0]).toMatchObject({
    state: "unsupported",
    reason: "rpc-method-not-found",
  });
  const tools = queryCached(
    { family: "tools" },
    config,
    stored,
    new Map(),
    emptyCursorState(),
    "test",
  );
  expect(tools.page.catalogs[0]).toMatchObject({ state: "ready" });
  expect(tools.page.catalogs[0]?.reason).toBeUndefined();
  const refreshing = queryCached(
    { family: "resources" },
    config,
    stored,
    new Map([["a", { owner: "owner", state: "refreshing" as const }]]),
    emptyCursorState(),
    "test",
  );
  expect(refreshing.page.catalogs[0]?.state).toBe("refreshing");
  const revoked = queryCached(
    { family: "resources" },
    { ...config, revision: 2 },
    stored,
    new Map(),
    emptyCursorState(),
    "test",
  );
  expect(revoked.page.catalogs[0]).toMatchObject({ state: "undiscovered" });
  expect(revoked.page.catalogs[0]?.reason).toBeUndefined();
});
it("search covers the catalog beyond its visible page and tool policy still applies", () => {
  const found = queryCached(
    { family: "tools", server: "a", query: "needle", limit: 1 },
    config,
    snapshots,
    new Map(),
    emptyCursorState(),
    "test",
  );
  expect(found.page.entries[0]?.ref.id).toBe("tool-149");
  expect(found.page.total).toBe(1);
  expect(
    queryCached(
      { family: "tools", query: "denied" },
      config,
      snapshots,
      new Map(),
      emptyCursorState(),
      "test",
    ).page.entries,
  ).toEqual([]);
});
it("cursor binding rejects changed query, config and metadata revisions", () => {
  const first = queryCached(
    { family: "tools", limit: 1 },
    config,
    snapshots,
    new Map(),
    emptyCursorState(),
    "test",
  );
  const cursor = first.page.next!;
  const second = queryCached(
    { family: "tools", cursor, limit: 1 },
    config,
    snapshots,
    new Map(),
    first.cursors,
    "test",
  );
  expect(second.page.entries[0]?.ref.id).toBe("tool-1");
  expect(() =>
    queryCached(
      { family: "tools", cursor, query: "needle" },
      config,
      snapshots,
      new Map(),
      first.cursors,
      "test",
    ),
  ).toThrow();
  expect(() =>
    queryCached(
      { family: "tools", cursor },
      { ...config, revision: 2 },
      snapshots,
      new Map(),
      first.cursors,
      "test",
    ),
  ).toThrow();
  expect(() =>
    queryCached(
      { family: "tools", cursor },
      config,
      new Map([["a", { ...snapshot, revision: 3 }]]),
      new Map(),
      first.cursors,
      "test",
    ),
  ).toThrow();
});
it("unsupported, undiscovered, failed refresh and invalidated states remain distinct", () => {
  expect(
    queryCached({ family: "resources" }, config, snapshots, new Map(), emptyCursorState(), "test")
      .page.catalogs[0]?.state,
  ).toBe("unsupported");
  expect(
    queryCached({ family: "tools" }, config, new Map(), new Map(), emptyCursorState(), "test").page
      .catalogs[0]?.state,
  ).toBe("undiscovered");
  expect(
    queryCached(
      { family: "tools" },
      config,
      snapshots,
      new Map([["a", { owner: "owner", state: "refresh-failed" }]]),
      emptyCursorState(),
      "test",
    ).page.catalogs[0]?.state,
  ).toBe("refresh-failed");
});
it("details preserve exact identifiers but bound descriptions and schemas without following references", () => {
  const long = {
    ...snapshot,
    tools: [
      {
        name: "exact\u001b[2J",
        description: "description".repeat(1000),
        inputSchema: { $ref: "https://never-fetch.invalid/schema", long: "x".repeat(20_000) },
      },
    ],
  };
  const values = new Map([["a", long]]);
  const entry = queryCached(
    { family: "tools" },
    config,
    values,
    new Map(),
    emptyCursorState(),
    "test",
  ).page.entries[0]!;
  expect(entry.ref.id).toBe("exact\u001b[2J");
  const detail = describeCached(entry.ref, config, values);
  expect(detail.name).toBe("exact");
  expect(detail.truncated).toBe(true);
  expect(detail.metadata.length).toBeLessThanOrEqual(16_384);
  expect(() => describeCached(entry.ref, config, new Map())).toThrow();
});
