import { expect, it } from "@effect/vitest";
import { InMemoryTransport, isJSONRPCRequest } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import { legacyProtocol } from "../../../src/boundary/mcp-protocol/legacy/adapter.ts";
import { makeSdkClient } from "../../../src/boundary/sdk-client.ts";
import { makeSdkEvents, type SdkSubscriptionTraffic } from "../../../src/boundary/sdk-events.ts";
import { boundaryError } from "../../../src/client/errors.ts";
import { legacyInitialized } from "../../fixtures/json-rpc.ts";

const legacyClient = (traffic?: SdkSubscriptionTraffic) =>
  Effect.gen(function* () {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = yield* Effect.acquireRelease(makeSdkClient("legacy"), (owned) =>
      Effect.promise(() => owned.close()),
    );
    const events = yield* makeSdkEvents(
      client,
      { closing: false, closed: false, cleanupUnconfirmed: false },
      traffic ? () => Effect.succeed(traffic) : undefined,
    );
    serverTransport.onmessage = (message) => {
      if (!isJSONRPCRequest(message)) return;
      if (message.method === "initialize")
        clientTransport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: legacyInitialized({ resources: { subscribe: true } }),
        });
      else if (message.method === "resources/subscribe")
        clientTransport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "Invalid URI" },
        });
    };
    yield* Effect.tryPromise({
      try: () => client.connect(events.bindTransport(clientTransport)),
      catch: () => boundaryError("connection", "not-sent", "Fixture connection failed."),
    });
    return { client, events, clientTransport };
  });

it.effect("legacy proven non-dispatch does not invent subscription cleanup uncertainty", () =>
  Effect.gen(function* () {
    const { client, events, clientTransport } = yield* legacyClient();
    clientTransport.send = () =>
      Promise.reject(
        boundaryError("connection", "not-sent", "Fixture transport admission closed."),
      );
    const error = yield* Effect.scoped(
      legacyProtocol.subscribeResource(client, events, "test://one", 100, 100),
    ).pipe(Effect.flip);
    expect(error).toMatchObject({ kind: "connection", outcome: "not-sent" });
    expect((yield* events.health).cleanupUnconfirmed).toBe(false);
  }),
);

it.effect("legacy correlated rejection still requires native cleanup confirmation", () =>
  Effect.gen(function* () {
    const { client, events } = yield* legacyClient({
      options: {},
      run: (callback) => callback(),
      close: Effect.fail(boundaryError("cleanup", "unknown", "Fixture native cleanup failed.")),
    });
    const error = yield* Effect.scoped(
      legacyProtocol.subscribeResource(client, events, "test://one", 100, 100),
    ).pipe(Effect.flip);
    expect(error).toMatchObject({ kind: "protocol", outcome: "completed" });
    expect((yield* events.health).cleanupUnconfirmed).toBe(true);
    expect(yield* events.terminal.pipe(Effect.flip)).toMatchObject({
      kind: "cleanup",
      outcome: "unknown",
    });
  }),
);

it.effect(
  "completed transport validation failure does not prove legacy establishment was rejected",
  () =>
    Effect.gen(function* () {
      const { client, events, clientTransport } = yield* legacyClient({
        options: {},
        run: (callback) => callback(),
        close: Effect.void,
        // Simulate HTTP completion evidence after rejecting a malformed acknowledgement.
        mapFailure: () => boundaryError("protocol", "completed", "Fixture invalid result."),
      });
      clientTransport.send = () => Promise.reject(new Error("Fixture invalid result."));
      const error = yield* Effect.scoped(
        legacyProtocol.subscribeResource(client, events, "test://one", 100, 100),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ kind: "protocol", outcome: "completed" });
      expect((yield* events.health).cleanupUnconfirmed).toBe(true);
    }),
);
