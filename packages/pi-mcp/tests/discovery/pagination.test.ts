import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { McpRequest } from "../../src/client/model.ts";
import type { McpOperation } from "../../src/connection/model.ts";
import { MCP_DISCOVERY_LIMITS, McpToolMetadataSchema } from "../../src/discovery/model.ts";
import {
  chargeMetadata,
  discoveryPage,
  emptyCursorState,
  listMetadata,
  metadataBudget,
} from "../../src/discovery/pagination.ts";

const operationFor = (page: (request: McpRequest) => Schema.Json) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const server = {
      id: "a",
      scope: "global" as const,
      directory: "/fixture",
      enabled: true,
      identity: "identity",
      definition: {
        transport: "stdio" as const,
        command: "fixture",
        args: [],
        environment: {},
        denyTools: [],
      },
    };
    const operation: McpOperation = {
      binding: { server: "a", identity: "identity", configRevision: 1 },
      server,
      owner: "owner",
      capabilities: { tools: true, resources: false, prompts: false },
      changes: Stream.never,
      checkCurrent: Effect.void,
      commit: (publication) => publication,
      request: (request) =>
        Effect.sync(() => ({
          action: request.action,
          outcome: "completed" as const,
          result: page(request),
        })),
      shared: (_key, use) => use(operation),
      forkOwned: (effect) => Effect.forkIn(effect, scope),
    };
    return operation;
  });
const traverse = (operation: McpOperation) =>
  listMetadata(
    operation,
    "tools.list",
    "tools",
    McpToolMetadataSchema,
    (tool) => tool.name,
    metadataBudget(),
  );
const tool = (name: string): Schema.Json => ({ name, inputSchema: { type: "object" } });

it.effect(
  "an empty remote cursor is valid and traversal stops only when nextCursor is absent",
  () =>
    Effect.gen(function* () {
      const cursors: Array<string | undefined> = [];
      const operation = yield* operationFor((request) => {
        const cursor = request.action === "tools.list" ? request.cursor : undefined;
        cursors.push(cursor);
        return cursor === undefined
          ? { tools: [tool("first")], nextCursor: "" }
          : { tools: [tool("last")] };
      });
      const entries = yield* traverse(operation);
      expect(entries.map((entry) => entry.name)).toEqual(["first", "last"]);
      expect(cursors).toEqual([undefined, ""]);
    }),
);

it.effect("repeated empty and nonempty cursors fail without publishing a partial list", () =>
  Effect.gen(function* () {
    for (const cursor of ["", "repeat"]) {
      let pages = 0;
      const operation = yield* operationFor(() => {
        pages++;
        return { tools: [], nextCursor: cursor };
      });
      const result = yield* Effect.result(traverse(operation));
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "protocol" } });
      expect(pages).toBe(2);
    }
  }),
);

it.effect("traversal bounds remote pages and total entries across pages", () =>
  Effect.gen(function* () {
    let pages = 0;
    const endless = yield* operationFor(() => ({ tools: [], nextCursor: String(++pages) }));
    expect(yield* Effect.result(traverse(endless))).toMatchObject({
      _tag: "Failure",
      failure: { kind: "output-limit" },
    });
    expect(pages).toBe(MCP_DISCOVERY_LIMITS.pages);
    const many = yield* operationFor((request) =>
      request.action === "tools.list" && request.cursor === undefined
        ? {
            tools: Array.from({ length: 1_000 }, (_, index) => tool(String(index))),
            nextCursor: "last",
          }
        : { tools: [tool("overflow")] },
    );
    expect(yield* Effect.result(traverse(many))).toMatchObject({
      _tag: "Failure",
      failure: { kind: "output-limit" },
    });
  }),
);

it.effect(
  "invalid metadata and duplicate names fail rather than selecting an ambiguous schema",
  () =>
    Effect.gen(function* () {
      const duplicate = yield* operationFor(() => ({ tools: [tool("same"), tool("same")] }));
      expect(yield* Effect.result(traverse(duplicate))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "protocol" },
      });
      const invalid = yield* operationFor(() => ({ tools: [{ name: "broken" }] }));
      expect(yield* Effect.result(traverse(invalid))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "protocol" },
      });
    }),
);

it("metadata limits charge UTF-8 and escaping across the whole snapshot before freezing", () => {
  const budget = metadataBudget();
  chargeMetadata("🙂".repeat(500_000), budget);
  expect(budget.bytes).toBe(2_000_002);
  expect(() => chargeMetadata("🙂".repeat(550_000), budget)).toThrow();
  const escaped = metadataBudget();
  chargeMetadata("\u0000", escaped);
  expect(escaped.bytes).toBe(8);
  let nested: Schema.Json = null;
  for (let index = 0; index < 66; index++) nested = [nested];
  expect(() => chargeMetadata(nested, metadataBudget())).toThrow();
});

it("local cursors reject mismatched bindings, malformed tokens, and invalid page limits", () => {
  const result = discoveryPage(
    [1, 2, 3],
    { limit: 1 },
    "server/revision/query",
    "private",
    emptyCursorState(),
  );
  const data = Schema.decodeUnknownSync(Schema.Struct({ nextCursor: Schema.String }))(result.data);
  expect(
    discoveryPage(
      [1, 2, 3],
      { cursor: data.nextCursor, limit: 1 },
      "server/revision/query",
      "private",
      result.state,
    ).data,
  ).toMatchObject({ items: [2] });
  for (const signature of [
    "other-server/revision/query",
    "server/new-revision/query",
    "server/revision/changed-query",
  ]) {
    expect(() =>
      discoveryPage([1, 2, 3], { cursor: data.nextCursor }, signature, "private", result.state),
    ).toThrow();
  }
  expect(() =>
    discoveryPage([1], { cursor: "" }, "server/revision/query", "private", result.state),
  ).toThrow();
  for (const limit of [0, 101, 1.5, Number.NaN])
    expect(() => discoveryPage([1], { limit }, "binding", "private", result.state)).toThrow();
});

it("cursor retention is bounded and evicted cursors are stale", () => {
  let state = emptyCursorState();
  let first = "";
  for (let index = 0; index <= MCP_DISCOVERY_LIMITS.retainedCursors; index++) {
    const page = discoveryPage([1, 2], { limit: 1 }, "binding", "private", state);
    state = page.state;
    if (index === 0)
      first = Schema.decodeUnknownSync(Schema.Struct({ nextCursor: Schema.String }))(
        page.data,
      ).nextCursor;
  }
  expect(state.entries.size).toBe(MCP_DISCOVERY_LIMITS.retainedCursors);
  expect(() => discoveryPage([1, 2], { cursor: first }, "binding", "private", state)).toThrowError(
    expect.objectContaining({ kind: "stale" }),
  );
});
