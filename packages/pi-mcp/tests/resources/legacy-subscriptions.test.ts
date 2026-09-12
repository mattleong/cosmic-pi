import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { openSdkStdio } from "../../src/boundary/sdk-stdio.ts";
import { McpExecution } from "../../src/tools/service.ts";
import { optionalFixture, projection } from "../fixtures/optional-features.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const privateMessage = "private-subscription-error";
const subscribe = { action: "resources.subscribe", server: "fixture", uri: "test://missing" };
const cases = [
  { code: -32602, kind: "protocol", reason: "rpc-invalid-params" },
  { code: -32601, kind: "unsupported", reason: "rpc-method-not-found" },
  { code: -32002, kind: "not-found", reason: "rpc-resource-not-found" },
] as const;
const initialized = {
  protocolVersion: "2025-11-25",
  capabilities: { resources: { subscribe: true } },
  serverInfo: { name: "fixture", version: "1" },
};

// The same rejection and later successful lease run through both owned transports.
const stdioScript = `
  import readline from "node:readline";
  const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "initialize") return reply(request.id, ${serialize(initialized)});
    if (request.method === "resources/subscribe" && request.params.uri === "test://missing")
      return send({ jsonrpc: "2.0", id: request.id, error: {
        code: Number(process.argv[1]), message: "${privateMessage}", data: { secret: "${privateMessage}" }
      } });
    return reply(request.id, {});
  });
`;

for (const transport of ["http", "stdio"] as const)
  it.live.each(cases)(
    `legacy ${transport} subscription rejection $code leaves the connection reusable`,
    ({ code, kind, reason }) => {
      const options =
        transport === "stdio"
          ? {
              protocol: "legacy" as const,
              open: openSdkStdio({
                protocol: "legacy",
                command: process.execPath,
                args: ["--input-type=module", "-e", stdioScript, "--", String(code)],
                environment: {},
                connectTimeoutMs: 2_000,
                requestTimeoutMs: 2_000,
                cleanupTimeoutMs: 1_000,
              }),
            }
          : { protocol: "legacy" as const };
      const fixture = optionalFixture((request) => {
        if (request.method === "initialize")
          return new Response(serialize({ jsonrpc: "2.0", id: request.id, result: initialized }), {
            headers: { "content-type": "application/json" },
          });
        if (request.method === "resources/subscribe" || request.method === "resources/unsubscribe")
          return new Response(
            serialize(
              request.method === "resources/subscribe" && request.params?.uri === "test://missing"
                ? {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code, message: privateMessage, data: { secret: privateMessage } },
                  }
                : { jsonrpc: "2.0", id: request.id, result: {} },
            ),
            { headers: { "content-type": "application/json" } },
          );
        return undefined;
      }, options);
      return Effect.gen(function* () {
        const execution = yield* McpExecution;
        const error = yield* execution.execute(subscribe, projection).pipe(Effect.flip);
        expect(error).toMatchObject({ kind, outcome: "completed", reason });
        expect(serialize(error)).not.toContain(privateMessage);
        expect(
          (yield* execution.execute(
            { action: "resources.subscriptions", server: "fixture" },
            projection,
          )).reply.data,
        ).toMatchObject({ result: { subscriptions: [] } });

        const valid = { ...subscribe, uri: "test://one" };
        expect((yield* execution.execute(valid, projection)).reply).toMatchObject({
          outcome: "completed",
          isError: false,
          data: { result: { subscribed: true, existing: false } },
        });
        expect(
          (yield* execution.execute({ ...valid, action: "resources.unsubscribe" }, projection))
            .reply,
        ).toMatchObject({ outcome: "completed", isError: false });
        // Success must reuse the healthy owner, not hide the rejection by reconnecting.
        expect(fixture.opens()).toBe(1);
        expect(
          (yield* execution.execute({ action: "disconnect", server: "fixture" }, projection)).reply,
        ).toMatchObject({
          outcome: "completed",
          isError: false,
          data: { result: { cleanup: "confirmed" } },
        });
      }).pipe(Effect.provide(fixture.layer));
    },
  );
