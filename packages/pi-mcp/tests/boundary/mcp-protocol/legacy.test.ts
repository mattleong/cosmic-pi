import { expect, it } from "@effect/vitest";
import type { FetchLike } from "@modelcontextprotocol/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { openSdkHttp } from "../../../src/boundary/sdk-http.ts";
import { legacyInitialized, parseWire, rpcError, rpcResult } from "../../fixtures/json-rpc.ts";

it.live.each(
  [400, 404, 200].flatMap((status) => [-32601, -32022].map((code) => ({ status, code }))),
)("allows explicit legacy evidence $code in HTTP $status negotiation replies", ({ status, code }) =>
  Effect.gen(function* () {
    let initializations = 0;
    const fetch: FetchLike = (_url, init) =>
      Promise.resolve().then(() => {
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const request = parseWire(init.body);
        if (request.id === undefined) return new Response(null, { status: 202 });
        if (request.method === "server/discover")
          return rpcError(
            request.id,
            code === -32022
              ? { code: -32022, message: "version", data: { supported: ["2025-11-25"] } }
              : { code: -32601, message: "unknown method" },
            status,
          );
        initializations++;
        return rpcResult(request.id, legacyInitialized());
      });
    const connection = yield* openSdkHttp({
      url: new URL("https://fixture.test/mcp"),
      fetch,
      connectTimeoutMs: 500,
      cleanupTimeoutMs: 200,
    });
    expect(connection.protocolVersion).toBe("2025-11-25");
    expect(initializations).toBe(1);
    yield* connection.close;
  }),
);

it.live.each(
  [401, 500, 404, 405].flatMap((status) => [true, false].map((session) => ({ status, session }))),
)(
  "observes background legacy GET HTTP $status with session=$session without confusing it with an application failure",
  ({ status, session }) =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          if (init?.method === "GET") {
            Deferred.doneUnsafe(received, Effect.void);
            return new Response(null, { status });
          }
          if (init?.method === "DELETE") return new Response(null, { status: 204 });
          const message = parseWire(init?.body);
          if (message.id === undefined) return new Response(null, { status: 202 });
          const headers = new Headers({ "content-type": "application/json" });
          if (session) headers.set("mcp-session-id", "session");
          return rpcResult(
            message.id,
            message.method === "tools/list"
              ? { tools: [] }
              : legacyInitialized({ tools: { listChanged: true } }),
            headers,
          );
        });
      const connection = yield* openSdkHttp({
        url: new URL("https://fixture.test/mcp"),
        protocol: "legacy",
        fetch,
        connectTimeoutMs: 500,
        cleanupTimeoutMs: 200,
      });
      yield* Deferred.await(received);
      if (status === 405 || (status === 404 && !session)) {
        yield* Effect.sleep(10);
        expect(yield* connection.health).toMatchObject({ closed: false, observation: "active" });
        expect(yield* connection.request({ action: "tools.list" })).toMatchObject({
          outcome: "completed",
          result: { tools: [] },
        });
      } else {
        expect((yield* connection.terminal.pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* connection.health).toMatchObject({ closed: true });
        if (status !== 404) expect((yield* connection.health).observation).toBe("failed");
        expect(yield* connection.request({ action: "tools.list" }).pipe(Effect.flip)).toMatchObject(
          { outcome: "not-sent" },
        );
      }
      yield* connection.close;
      expect((yield* connection.health).cleanupUnconfirmed).toBe(false);
    }),
);
