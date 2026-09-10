import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { checkConfigBounds, decodeMcpDocument, decodeMcpServer } from "../../src/config/schema.ts";

describe("MCP configuration boundaries", () => {
  it.effect("rejects unsupported versions without exposing document contents", () =>
    Effect.gen(function* () {
      expect((yield* decodeMcpDocument({}).pipe(Effect.flip)).kind).toBe("config");
      for (const version of [null, 0, 2, "1"]) {
        const error = yield* decodeMcpDocument({ version, secret: "private-token" }).pipe(
          Effect.flip,
        );
        expect(error.kind).toBe("config");
        expect(error.message).not.toContain("private-token");
      }
    }),
  );

  it.effect("bounds nested config and individual entries before recursive decoding", () =>
    Effect.gen(function* () {
      let nested: Schema.Json = {};
      for (let index = 0; index < 20; index++) nested = { nested };
      expect((yield* checkConfigBounds(nested).pipe(Effect.flip)).kind).toBe("config");
      const entry = {
        transport: "stdio",
        command: "server",
        args: Array.from({ length: 20 }, () => "x".repeat(8_192)),
      };
      expect((yield* decodeMcpServer(entry).pipe(Effect.flip)).kind).toBe("config");
    }),
  );

  it.effect("rejects ambiguous credentials, implicit env values, and conflicting transports", () =>
    Effect.gen(function* () {
      const bad: Schema.Json[] = [
        { transport: "stdio", command: "server", environment: { TOKEN: "secret" } },
        {
          transport: "stdio",
          command: "server",
          environment: { TOKEN: { env: "TOKEN", value: "secret" } },
        },
        { transport: "http", url: "https://user:secret@example.test/mcp" },
        { transport: "http", url: "https://example.test", command: "server" },
        {
          transport: "http",
          url: "https://example.test",
          headers: { Authorization: { value: "one\r\nx-two: secret" } },
        },
        {
          transport: "http",
          url: "https://example.test",
          auth: { type: "oauth", registration: "pre-registered" },
        },
      ];
      for (const value of bad)
        expect((yield* decodeMcpServer(value).pipe(Effect.flip)).kind).toBe("config");
    }),
  );

  it.effect(
    "accepts disabled tombstones even when their stale transport fields are malformed",
    () =>
      Effect.gen(function* () {
        expect(
          yield* decodeMcpServer({ enabled: false, transport: "other", auth: "secret" }),
        ).toEqual({
          enabled: false,
        });
      }),
  );
});
