import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { checkConfigBounds, decodeMcpDocument, decodeMcpServer } from "../../src/config/schema.ts";

describe("MCP configuration boundaries", () => {
  it.effect("requires mcpServers and rejects legacy roots, including mixed documents", () =>
    Effect.gen(function* () {
      for (const value of [
        {},
        { version: 1 },
        { servers: {}, mcpServers: {} },
        { version: 1, servers: {}, mcpServers: {} },
      ]) {
        const error = yield* decodeMcpDocument(value).pipe(Effect.flip);
        expect(error.kind).toBe("config");
      }
      const error = yield* decodeMcpDocument({
        version: 1,
        mcpServers: {},
        secret: "private-token",
      }).pipe(Effect.flip);
      expect(error.message).not.toContain("private-token");
    }),
  );

  it.effect("accepts minimal stdio and HTTP servers with inferred or explicit types", () =>
    Effect.gen(function* () {
      const document = yield* decodeMcpDocument({
        mcpServers: {
          inferredStdio: { command: "server" },
          explicitStdio: { type: "stdio", command: "server", env: { TOKEN: "${TOKEN}" } },
          inferredHttp: { url: "https://example.test/mcp" },
          explicitHttp: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { "X-Client": "pi" },
          },
        },
      });
      for (const server of Object.values(document.mcpServers))
        expect(yield* decodeMcpServer(server)).toEqual(server);
    }),
  );

  it.effect("rejects conflicting transports, old fields, and binding objects", () =>
    Effect.gen(function* () {
      const bad: Schema.Json[] = [
        { transport: "stdio", command: "server" },
        { command: "server", environment: { TOKEN: "secret" } },
        { command: "server", env: { TOKEN: { env: "TOKEN" } } },
        { url: "https://example.test", headers: { Authorization: { value: "secret" } } },
        { command: "server", url: "https://example.test" },
        { type: "http", command: "server" },
        { type: "stdio", url: "https://example.test" },
        { type: "stdio", command: "server", headers: {} },
        { type: "http", url: "https://example.test", env: {} },
        { type: "other", command: "server" },
        { url: "https://user:secret@example.test/mcp" },
        { url: "https://example.test", headers: { Authorization: "one\r\nx-two: secret" } },
        {
          url: "https://example.test",
          auth: { type: "oauth", registration: "pre-registered" },
        },
      ];
      for (const value of bad)
        expect((yield* decodeMcpServer(value).pipe(Effect.flip)).kind).toBe("config");
    }),
  );

  it.effect("bounds nested config and individual entries before recursive decoding", () =>
    Effect.gen(function* () {
      let nested: Schema.Json = {};
      for (let index = 0; index < 20; index++) nested = { nested };
      expect((yield* checkConfigBounds(nested).pipe(Effect.flip)).kind).toBe("config");
      const entry = {
        command: "server",
        args: Array.from({ length: 20 }, () => "x".repeat(8_192)),
      };
      expect((yield* decodeMcpServer(entry).pipe(Effect.flip)).kind).toBe("config");
    }),
  );

  it.effect("accepts disabled tombstones without inspecting stale transport fields", () =>
    Effect.gen(function* () {
      expect(
        yield* decodeMcpServer({ enabled: false, transport: "other", auth: "secret" }),
      ).toEqual({
        enabled: false,
      });
    }),
  );
});
