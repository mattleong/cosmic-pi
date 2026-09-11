import { InMemoryTransport, isJSONRPCRequest } from "@modelcontextprotocol/client";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { makeSdkEvents, sdkCapabilities } from "../../src/boundary/sdk-events.ts";
import { boundaryError } from "../../src/client/errors.ts";
import {
  boundedSdkInstructions,
  decodeMcpReply,
  decodeMcpRequest,
  executeSdkRequest,
  makeSdkClient,
} from "../../src/boundary/sdk-client.ts";

it.each([
  { name: "absent", text: undefined, expected: undefined },
  { name: "empty", text: "", expected: { text: "", truncated: false } },
  {
    name: "exact bound",
    text: "x".repeat(65_536),
    expected: { text: "x".repeat(65_536), truncated: false },
  },
  {
    name: "oversized",
    text: "x".repeat(65_537),
    expected: { text: "x".repeat(65_536), truncated: true },
  },
  {
    name: "multibyte boundary",
    text: "x".repeat(65_533) + "😀suffix",
    expected: { text: "x".repeat(65_533), truncated: true },
  },
  {
    name: "exact multibyte bound",
    text: "😀".repeat(16_384),
    expected: { text: "😀".repeat(16_384), truncated: false },
  },
])("bounds $name initialize instructions without splitting characters", ({ text, expected }) => {
  const snapshot = boundedSdkInstructions(text);
  expect(snapshot).toEqual(expected);
  if (snapshot !== undefined) {
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(new TextEncoder().encode(snapshot.text).byteLength).toBeLessThanOrEqual(65_536);
  }
});

const makeClientHarness = Effect.gen(function* () {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.onmessage = (message) => {
    if (!isJSONRPCRequest(message)) return;
    if (message.method === "initialize") {
      clientTransport.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: true }, prompts: {} },
          serverInfo: { name: "sdk-test-server", version: "1" },
        },
      });
      return;
    }
    if (message.method === "tools/call") {
      clientTransport.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "tool failed" }],
          structuredContent: { reason: "test" },
          isError: true,
        },
      });
    }
  };
  const client = yield* Effect.acquireRelease(makeSdkClient(), (owned) =>
    Effect.promise(() => owned.close()),
  );
  yield* Effect.tryPromise({
    try: () => client.connect(clientTransport),
    catch: () => boundaryError("connection", "not-sent", "Fixture connection failed."),
  });
  return { client, clientTransport };
});

it.effect(
  "dispatches through the public SDK wire schema without compiling remote JSON schema",
  () =>
    Effect.gen(function* () {
      const { client } = yield* makeClientHarness;
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          executeSdkRequest(
            client,
            { action: "tools.call", tool: "example", arguments: { value: "input" } },
            { timeout: 1_000, signal },
          ),
        catch: () => boundaryError("protocol", "unknown", "Fixture request failed."),
      });

      expect(result).toEqual({
        content: [{ type: "text", text: "tool failed" }],
        structuredContent: { reason: "test" },
        isError: true,
      });
    }),
);

it.effect("keeps request decoding closed and rejects excess fields", () =>
  Effect.gen(function* () {
    expect(yield* decodeMcpRequest({ action: "tools.list" })).toEqual({ action: "tools.list" });
    const rejected = yield* decodeMcpRequest({
      action: "tools.list",
      privateOperation: "connect",
    }).pipe(Effect.result);
    expect(rejected).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-input" } });
  }),
);

it.effect("preserves completed error results during reply projection", () =>
  Effect.gen(function* () {
    const result = yield* decodeMcpReply("tools.call", {
      content: [{ type: "text", text: "failed" }],
      structuredContent: { reason: "test" },
      isError: true,
    });
    expect(result.outcome).toBe("completed");
    expect(result.result).toEqual({
      content: [{ type: "text", text: "failed" }],
      structuredContent: { reason: "test" },
      isError: true,
    });
  }),
);

it.effect("coalesces metadata changes and ends delivery on terminal transport closure", () =>
  Effect.gen(function* () {
    const { client, clientTransport } = yield* makeClientHarness;
    const state = { closing: false, closed: false, cleanupUnconfirmed: false };
    const events = yield* makeSdkEvents(client, state);
    expect(yield* sdkCapabilities(client)).toEqual({
      tools: true,
      resources: false,
      prompts: true,
    });
    for (let i = 0; i < 100; i++) {
      for (const family of ["tools", "resources", "prompts"]) {
        clientTransport.onmessage?.({
          jsonrpc: "2.0",
          method: `notifications/${family}/list_changed`,
        });
      }
    }
    // SDK callback delivery is asynchronous; let this burst reach the bounded ingress.
    yield* Effect.yieldNow;
    const delivered: string[] = [];
    const reader = yield* events.changes.pipe(
      Stream.runForEach((family) =>
        Effect.sync(() => {
          delivered.push(family);
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* Effect.promise(() => client.close());
    expect(yield* events.terminal.pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { kind: "transport" },
    });
    yield* Fiber.join(reader);
    expect(delivered.sort()).toEqual(["prompts", "resources", "tools"]);
    expect(yield* events.health).toEqual({ closed: true, cleanupUnconfirmed: false });
  }),
);
