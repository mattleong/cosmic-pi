import { expect, it } from "@effect/vitest";
import type { FetchLike } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import { openSdkHttp } from "../../../src/boundary/sdk-http.ts";
import { legacyInitialized, parseWire, rpcResult } from "../../fixtures/json-rpc.ts";

it.live.each(["auto", "legacy"] as const)(
  "keeps pre-initialization rejection separate from authentication in %s mode",
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
                error: { code: -32600, message: "private-server-error" },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          if (request.id === undefined) return new Response(null, { status: 202 });
          return rpcResult(request.id, legacyInitialized());
        });
      const result = yield* openSdkHttp({
        url: new URL("https://fixture.test/mcp"),
        token: "private-token",
        protocol,
        fetch,
        connectTimeoutMs: 1_000,
        cleanupTimeoutMs: 200,
        onCleanup: (confirmed) => cleanup.push(confirmed),
      }).pipe(Effect.result);
      if (protocol === "auto") {
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") throw new Error("Expected negotiation rejection.");
        expect(result.failure).toMatchObject({
          kind: "protocol",
          outcome: "unknown",
          reason: "protocol-negotiation-rejected",
        });
        // Rejected, uncorrelated evidence cannot trigger initialize or an application RPC.
        expect(methods).toEqual(["server/discover"]);
        expect(String(result)).not.toContain("private-");
      } else {
        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") throw new Error("Expected legacy connection.");
        expect(result.success.protocolVersion).toBe("2025-11-25");
        expect(methods).not.toContain("server/discover");
        expect(methods).toContain("initialize");
        yield* result.success.close;
      }
      expect(cleanup).toEqual([true]);
    }),
);
