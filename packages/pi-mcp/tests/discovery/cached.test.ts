import { expect, it } from "vitest";
import type { McpResolvedConfig } from "../../src/config/model.ts";
import { describeCached, type McpCacheEvidence, queryCached } from "../../src/discovery/cached.ts";
import type { McpCachedRequest, McpMetadataSnapshot } from "../../src/discovery/model.ts";
import { emptyCursorState, type McpCursorState } from "../../src/discovery/pagination.ts";
import { stdioDefinition, testConfig, testServer } from "../fixtures/services.ts";

const config = testConfig({
  servers: {
    a: testServer("a", {
      identity: "identity",
      definition: stdioDefinition({ denyTools: ["denied"] }),
    }),
  },
});
const snapshot: McpMetadataSnapshot = {
  server: "a",
  owner: "owner",
  identity: "identity",
  configRevision: 1,
  authorizationRevision: 0,
  revision: 2,
  expiresAt: 60_000,
  cacheScope: "private",
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
const query = (
  request: McpCachedRequest,
  o: {
    at?: McpResolvedConfig;
    stored?: ReadonlyMap<string, McpMetadataSnapshot>;
    evidence?: ReadonlyMap<string, McpCacheEvidence>;
    cursors?: McpCursorState;
  } = {},
) =>
  queryCached(
    request,
    o.at ?? config,
    o.stored ?? snapshots,
    o.evidence ?? new Map(),
    o.cursors ?? emptyCursorState(),
    "test",
  );
it("family diagnostics follow the visible snapshot and retain refresh-state precedence", () => {
  const partial: McpMetadataSnapshot = {
    ...snapshot,
    diagnostics: [{ family: "resources", reason: "rpc-method-not-found" }],
  };
  const stored = new Map([["a", partial]]);
  const resources = query({ family: "resources" }, { stored });
  expect(resources.page.catalogs[0]).toMatchObject({
    state: "unsupported",
    reason: "rpc-method-not-found",
  });
  const tools = query({ family: "tools" }, { stored });
  expect(tools.page.catalogs[0]).toMatchObject({ state: "ready" });
  expect(tools.page.catalogs[0]?.reason).toBeUndefined();
  const refreshing = query(
    { family: "resources" },
    { stored, evidence: new Map([["a", { owner: "owner", state: "refreshing" as const }]]) },
  );
  expect(refreshing.page.catalogs[0]?.state).toBe("refreshing");
  const revoked = query({ family: "resources" }, { at: { ...config, revision: 2 }, stored });
  expect(revoked.page.catalogs[0]).toMatchObject({ state: "undiscovered" });
  expect(revoked.page.catalogs[0]?.reason).toBeUndefined();
});
it("search covers the catalog beyond its visible page and tool policy still applies", () => {
  const found = query({ family: "tools", server: "a", query: "needle", limit: 1 });
  expect(found.page.entries[0]?.ref.id).toBe("tool-149");
  expect(found.page.total).toBe(1);
  expect(query({ family: "tools", query: "denied" }).page.entries).toEqual([]);
});
it("catalog-only reads keep full permitted counts without consuming browser cursors", () => {
  const first = query({ family: "tools", limit: 1 });
  let cursors = first.cursors;
  for (let index = 0; index < 1050; index++) {
    const observed = query({ family: "tools", catalogsOnly: true }, { cursors });
    expect(observed.page.entries).toEqual([]);
    expect(observed.page.next).toBeUndefined();
    expect(observed.page.catalogs[0]).toMatchObject({ state: "ready", count: 150 });
    cursors = observed.cursors;
  }
  const next = query({ family: "tools", cursor: first.page.next!, limit: 1 }, { cursors });
  expect(next.page.entries[0]?.ref.id).toBe("tool-1");
});

it("cursor binding rejects changed query, config and metadata revisions", () => {
  const first = query({ family: "tools", limit: 1 });
  const cursor = first.page.next!;
  const second = query({ family: "tools", cursor, limit: 1 }, { cursors: first.cursors });
  expect(second.page.entries[0]?.ref.id).toBe("tool-1");
  expect(() =>
    query({ family: "tools", cursor, query: "needle" }, { cursors: first.cursors }),
  ).toThrow();
  expect(() =>
    query({ family: "tools", cursor }, { at: { ...config, revision: 2 }, cursors: first.cursors }),
  ).toThrow();
  expect(() =>
    query(
      { family: "tools", cursor },
      { stored: new Map([["a", { ...snapshot, revision: 3 }]]), cursors: first.cursors },
    ),
  ).toThrow();
});
it("unsupported, undiscovered, failed refresh and invalidated states remain distinct", () => {
  expect(query({ family: "resources" }).page.catalogs[0]?.state).toBe("unsupported");
  expect(query({ family: "tools" }, { stored: new Map() }).page.catalogs[0]?.state).toBe(
    "undiscovered",
  );
  expect(
    query(
      { family: "tools" },
      { evidence: new Map([["a", { owner: "owner", state: "refresh-failed" }]]) },
    ).page.catalogs[0]?.state,
  ).toBe("refresh-failed");
});
it("catalog-only reads distinguish withdrawn metadata from first discovery and hide untrusted catalogs", () => {
  const evidence = new Map([["a", { owner: "owner", state: "invalidated" as const }]]);
  expect(
    query({ family: "tools", catalogsOnly: true }, { stored: new Map(), evidence }).page.catalogs[0]
      ?.state,
  ).toBe("invalidated");
  expect(
    query({ family: "tools", catalogsOnly: true }, { at: { ...config, trusted: false }, evidence })
      .page.catalogs,
  ).toEqual([]);
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
  const entry = query({ family: "tools" }, { stored: values }).page.entries[0]!;
  expect(entry.ref.id).toBe("exact\u001b[2J");
  const detail = describeCached(entry.ref, config, values);
  expect(detail.name).toBe("exact");
  expect(detail.truncated).toBe(true);
  expect(detail.metadata.length).toBeLessThanOrEqual(16_384);
  expect(() => describeCached(entry.ref, config, new Map())).toThrow();
});

it("ranks cached resources and templates by full metadata while retaining URI search and exact refs", () => {
  const stored = new Map([
    [
      "a",
      {
        ...snapshot,
        support: { ...snapshot.support, resources: true, templates: true },
        resources: [
          {
            name: "ordinary",
            uri: "mcp://host/read_file",
            description: "x".repeat(600) + "\n\narchived data",
          },
          { name: "title", uri: "mcp://host/title", title: "Read file" },
          { name: "name", uri: "mcp://host/name", description: "Read file" },
        ],
        templates: [{ name: "template", uriTemplate: "mcp://host/read_file/{id}" }],
      },
    ],
  ]);
  const first = query({ family: "resources", query: "read file", limit: 1 }, { stored });
  expect(first.page.total).toBe(3);
  expect(first.page.entries[0]?.ref.id).toBe("mcp://host/read_file");
  const second = query(
    { family: "resources", query: "read file", limit: 1, cursor: first.page.next! },
    { stored, cursors: first.cursors },
  );
  expect(second.page.entries[0]?.ref.id).toBe("mcp://host/title");
  for (const [family, text, id] of [
    ["resources", "archived data", "mcp://host/read_file"],
    ["resources", "mcp://host/read_file", "mcp://host/read_file"],
    ["templates", "read file", "mcp://host/read_file/{id}"],
  ] as const) {
    const found = query({ family, query: text }, { stored });
    expect(found.page.entries[0]?.ref.id).toBe(id);
  }
});

it("cached cursor identity includes owner, refresh evidence and camel-case query tokenization", () => {
  const first = query({ family: "tools", query: "tool", limit: 1 });
  for (const [stored, evidence] of [
    [new Map([["a", { ...snapshot, owner: "replacement" }]]), new Map()],
    [snapshots, new Map([["a", { owner: snapshot.owner, state: "refreshing" as const }]])],
  ] as const) {
    expect(() =>
      query(
        { family: "tools", query: "tool", cursor: first.page.next! },
        { stored, evidence, cursors: first.cursors },
      ),
    ).toThrowError(expect.objectContaining({ kind: "stale" }));
  }
  const stored = new Map([
    [
      "a",
      {
        ...snapshot,
        tools: [
          { name: "readFile", inputSchema: {} },
          { name: "read_file", inputSchema: {} },
        ],
      },
    ],
  ]);
  const page = query({ family: "tools", query: "readFile", limit: 1 }, { stored });
  expect(() =>
    query(
      { family: "tools", query: "readfile", cursor: page.page.next! },
      { stored, cursors: page.cursors },
    ),
  ).toThrowError(expect.objectContaining({ kind: "stale" }));
});
