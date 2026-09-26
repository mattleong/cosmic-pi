import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/unstable/http";
import { openSdkHttp } from "../../src/boundary/sdk-http.ts";
import { openSdkStdio } from "../../src/boundary/sdk-stdio.ts";
import type { McpConnection } from "../../src/client/model.ts";
import { startHttpServer } from "../fixtures/http-server.ts";
import { legacyInitialized, parseWireOption } from "../fixtures/json-rpc.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const handshake = legacyInitialized({ tools: {} });
// Pure bounding cases live with boundedSdkInstructions; each transport proves only its wiring.
const cases = [
  { name: "absent", text: undefined, expected: undefined },
  {
    name: "oversized multibyte",
    text: "😀".repeat(16_385),
    expected: { text: "😀".repeat(16_384), truncated: true },
  },
];
const expectCaptured = (connection: McpConnection, expected: (typeof cases)[number]["expected"]) =>
  Effect.gen(function* () {
    expect(connection.instructions).toEqual(expected);
    expect(connection.protocolVersion).toBe(handshake.protocolVersion);
    expect((yield* connection.request({ action: "tools.list" })).result).toEqual({ tools: [] });
    expect(connection.instructions).toEqual(expected);
    yield* connection.close;
    expect(yield* connection.health).toMatchObject({ closed: true, cleanupUnconfirmed: false });
  });

it.live.each(cases)(
  "captures $name instructions from an owned HTTP handshake",
  ({ text, expected }) =>
    Effect.gen(function* () {
      const initialized = text === undefined ? handshake : { ...handshake, instructions: text };
      const fixture = yield* startHttpServer((request) => {
        if (request.method === "GET")
          return Effect.succeed(HttpServerResponse.empty({ status: 405 }));
        const message = Option.getOrUndefined(parseWireOption(request.body));
        if (message?.id === undefined)
          return Effect.succeed(HttpServerResponse.empty({ status: 202 }));
        return Effect.succeed(
          HttpServerResponse.text(
            json({
              jsonrpc: "2.0",
              id: message.id,
              result: message.method === "initialize" ? initialized : { tools: [] },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      });
      yield* expectCaptured(yield* openSdkHttp({ url: fixture.url, protocol: "legacy" }), expected);
    }),
);

it.live.each(cases)(
  "captures $name instructions from an owned stdio handshake",
  ({ text, expected }) =>
    process.platform !== "darwin"
      ? Effect.void
      : Effect.gen(function* () {
          const initialized = text === undefined ? handshake : { ...handshake, instructions: text };
          // This owned child speaks only the fixture handshake and an empty tool catalog.
          const script = `
      const readline = require('node:readline');
      const initialized = ${json(initialized)};
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          result: message.method === 'initialize' ? initialized : { tools: [] }
        }) + '\\n');
      });
    `;
          const connection = yield* openSdkStdio({
            protocol: "legacy",
            command: process.execPath,
            args: ["-e", script],
            environment: {},
          });
          yield* expectCaptured(connection, expected);
        }),
);
