import { expect, it } from "@effect/vitest";
import type { FetchLike } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import { openSdkHttp } from "../../../src/boundary/sdk-http.ts";
import { legacyInitialized, parseWire, rpcResult } from "../../fixtures/json-rpc.ts";

// Stateful 2025-era HTTP servers answer an unknown pre-initialize request with an
// uncorrelated 400, as Atlassian's endpoint did; that is legacy evidence.
it.live.each(["auto", "legacy"] as const)(
  "falls back to legacy after an uncorrelated 400 probe in %s mode",
  (protocol) =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const cleanup: boolean[] = [];
      const fetch: FetchLike = (_url, init) =>
        Promise.resolve().then(() => {
          if (init?.method !== "POST") return new Response(null, { status: 405 });
          const request = parseWire(init.body);
          methods.push(request.method);
          if (request.method === "server/discover")
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Bad Request: No valid session ID provided" },
                id: null,
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          if (request.id === undefined) return new Response(null, { status: 202 });
          return rpcResult(request.id, legacyInitialized());
        });
      const connection = yield* openSdkHttp({
        url: new URL("https://fixture.test/mcp"),
        token: "private-token",
        protocol,
        fetch,
        connectTimeoutMs: 1_000,
        cleanupTimeoutMs: 200,
        onCleanup: (confirmed) => cleanup.push(confirmed),
      });
      expect(connection.protocolVersion).toBe("2025-11-25");
      expect(methods).toContain("initialize");
      expect(methods.includes("server/discover")).toBe(protocol === "auto");
      yield* connection.close;
      expect(cleanup).toEqual([true]);
    }),
);
