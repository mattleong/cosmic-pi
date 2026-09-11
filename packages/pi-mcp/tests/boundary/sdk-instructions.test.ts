import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/unstable/http";
import { openSdkHttp } from "../../src/boundary/sdk-http.ts";
import { openSdkStdio } from "../../src/boundary/sdk-stdio.ts";
import { startHttpServer } from "../fixtures/http-server.ts";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      id: Schema.optionalKey(Schema.Finite),
    }),
  ),
);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const handshake = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  serverInfo: { name: "instructions-fixture", version: "1" },
};
const cases = [
  { name: "absent", text: undefined, expected: undefined },
  { name: "empty", text: "", expected: { text: "", truncated: false } },
  {
    name: "supplied",
    text: "Use the server's documented workflow.",
    expected: { text: "Use the server's documented workflow.", truncated: false },
  },
  {
    name: "oversized multibyte",
    text: "😀".repeat(16_385),
    expected: { text: "😀".repeat(16_384), truncated: true },
  },
];

it.live.each(cases)(
  "captures $name instructions from an owned HTTP handshake",
  ({ text, expected }) =>
    Effect.gen(function* () {
      const initialized = text === undefined ? handshake : { ...handshake, instructions: text };
      const fixture = yield* startHttpServer((request) => {
        if (request.method === "GET")
          return Effect.succeed(HttpServerResponse.empty({ status: 405 }));
        const message = Option.getOrUndefined(decode(request.body));
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
      const connection = yield* openSdkHttp({ url: fixture.url });
      expect(connection.instructions).toEqual(expected);
      expect(connection.protocolVersion).toBe(handshake.protocolVersion);
      expect((yield* connection.request({ action: "tools.list" })).result).toEqual({ tools: [] });
      expect(connection.instructions).toEqual(expected);
      yield* connection.close;
      expect(yield* connection.health).toEqual({ closed: true, cleanupUnconfirmed: false });
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
            command: process.execPath,
            args: ["-e", script],
            environment: {},
          });
          expect(connection.instructions).toEqual(expected);
          expect(connection.protocolVersion).toBe(handshake.protocolVersion);
          expect((yield* connection.request({ action: "tools.list" })).result).toEqual({
            tools: [],
          });
          expect(connection.instructions).toEqual(expected);
          yield* connection.close;
          expect(yield* connection.health).toEqual({ closed: true, cleanupUnconfirmed: false });
        }),
);
