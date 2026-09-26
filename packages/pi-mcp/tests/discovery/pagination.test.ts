import { Buffer } from "node:buffer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { McpRequest } from "../../src/client/model.ts";
import { boundaryError } from "../../src/client/errors.ts";
import type { McpOperation } from "../../src/connection/model.ts";
import { MCP_DISCOVERY_LIMITS, McpToolMetadataSchema } from "../../src/discovery/model.ts";
import {
  discoveryPage,
  emptyCursorState,
  listMetadata,
  metadataBudget,
} from "../../src/discovery/pagination.ts";
import { fakeOperation } from "../fixtures/services.ts";

const operationFor = (page: (request: McpRequest) => Schema.Json) =>
  fakeOperation({
    request: (request) =>
      Effect.sync(() => ({ action: request.action, outcome: "completed", result: page(request) })),
  });
const traverse = (operation: McpOperation, budget = metadataBudget()) =>
  listMetadata(
    operation,
    "tools.list",
    "tools",
    McpToolMetadataSchema,
    (tool) => tool.name,
    budget,
  );
const tool = (name: string): Schema.Json => ({ name, inputSchema: { type: "object" } });
const missingMethod = boundaryError(
  "unsupported",
  "completed",
  "private-server-message",
  "rpc-method-not-found",
);

it.effect(
  "an empty remote cursor is valid and traversal stops only when nextCursor is absent",
  () =>
    Effect.gen(function* () {
      const cursors: Array<string | undefined> = [];
      const operation = operationFor((request) => {
        const cursor = request.action === "tools.list" ? request.cursor : undefined;
        cursors.push(cursor);
        return cursor === undefined
          ? { tools: [tool("first")], nextCursor: "" }
          : { tools: [tool("last")] };
      });
      const entries = yield* traverse(operation);
      expect(entries.entries.map((entry) => entry.name)).toEqual(["first", "last"]);
      expect(cursors).toEqual([undefined, ""]);
    }),
);

it.effect("only an explicit first-page missing method becomes an unsupported catalog", () =>
  Effect.gen(function* () {
    const operation = operationFor(() => ({ tools: [] }));
    const result = yield* traverse({ ...operation, request: () => Effect.fail(missingMethod) });
    expect(result).toEqual({ supported: false, entries: [], reason: "rpc-method-not-found" });
    expect(yield* traverse(operation)).toMatchObject({
      supported: true,
      entries: [],
      expiresAt: 0,
      cacheScope: "private",
    });
  }),
);

it.effect.each([
  boundaryError("unsupported", "not-sent", "not sent", "rpc-method-not-found"),
  boundaryError("unsupported", "unknown", "uncertain", "rpc-method-not-found"),
  boundaryError("unsupported", "completed", "another unsupported interaction"),
  boundaryError("auth-required", "completed", "rejected credentials", "rpc-method-not-found"),
  boundaryError("protocol", "completed", "invalid response", "rpc-invalid-params"),
  boundaryError("timeout", "unknown", "expired"),
  boundaryError("cleanup", "unknown", "unconfirmed"),
])("does not downgrade other discovery failures", (failure) =>
  Effect.gen(function* () {
    const operation = operationFor(() => ({ tools: [] }));
    expect(
      yield* traverse({ ...operation, request: () => Effect.fail(failure) }).pipe(Effect.flip),
    ).toBe(failure);
  }),
);

it.effect.each(["", "next"])(
  "does not discard a traversal when a later page reports a missing method",
  (cursor) =>
    Effect.gen(function* () {
      const operation = operationFor(() => ({ tools: [tool("first")], nextCursor: cursor }));
      const paged = {
        ...operation,
        request: (request: McpRequest) =>
          request.action === "tools.list" && request.cursor !== undefined
            ? Effect.fail(missingMethod)
            : operation.request(request),
      };
      expect(yield* traverse(paged).pipe(Effect.flip)).toBe(missingMethod);
    }),
);

it.effect("repeated empty and nonempty cursors fail without publishing a partial list", () =>
  Effect.gen(function* () {
    for (const cursor of ["", "repeat"]) {
      let pages = 0;
      const operation = operationFor(() => {
        pages++;
        return { tools: [], nextCursor: cursor };
      });
      expect((yield* traverse(operation).pipe(Effect.flip)).kind).toBe("protocol");
      expect(pages).toBe(2);
    }
  }),
);

it.effect("traversal bounds remote pages and total entries across pages", () =>
  Effect.gen(function* () {
    let pages = 0;
    const endless = operationFor(() => ({ tools: [], nextCursor: String(++pages) }));
    expect((yield* traverse(endless).pipe(Effect.flip)).kind).toBe("output-limit");
    expect(pages).toBe(MCP_DISCOVERY_LIMITS.pages);
    const many = operationFor((request) =>
      request.action === "tools.list" && request.cursor === undefined
        ? {
            tools: Array.from({ length: 1_000 }, (_, index) => tool(String(index))),
            nextCursor: "last",
          }
        : { tools: [tool("overflow")] },
    );
    expect((yield* traverse(many).pipe(Effect.flip)).kind).toBe("output-limit");
  }),
);

it.effect(
  "invalid metadata and duplicate names fail rather than selecting an ambiguous schema",
  () =>
    Effect.gen(function* () {
      const duplicate = operationFor(() => ({ tools: [tool("same"), tool("same")] }));
      expect((yield* traverse(duplicate).pipe(Effect.flip)).kind).toBe("protocol");
      const invalid = operationFor(() => ({ tools: [{ name: "broken" }] }));
      expect((yield* traverse(invalid).pipe(Effect.flip)).kind).toBe("protocol");
    }),
);

it.effect("one metadata budget bounds exact UTF-8 and depth across pages and listings", () =>
  Effect.gen(function* () {
    const pages = [{ tools: [tool("🙂\u0000")], nextCursor: "next" }, { tools: [tool("last")] }];
    const bytes = pages.reduce((total, page) => total + Buffer.byteLength(JSON.stringify(page)), 0);
    const operation = operationFor((request) =>
      request.action === "tools.list" && request.cursor !== undefined ? pages[1]! : pages[0]!,
    );
    const budget = metadataBudget();
    yield* traverse(operation, budget);
    yield* traverse(operation, budget);
    expect(budget.bytes).toBe(2 * bytes);
    const remaining = MCP_DISCOVERY_LIMITS.metadataBytes - bytes;
    yield* traverse(operation, { bytes: remaining, nodes: 0 });
    const overflow = traverse(operation, { bytes: remaining + 1, nodes: 0 });
    expect((yield* Effect.flip(overflow)).kind).toBe("output-limit");
    let nested: Schema.Json = null;
    for (let index = 0; index < MCP_DISCOVERY_LIMITS.metadataDepth; index++) nested = [nested];
    const deep = operationFor(() => ({ tools: [], nested }));
    expect((yield* Effect.flip(traverse(deep))).kind).toBe("output-limit");
  }),
);

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
