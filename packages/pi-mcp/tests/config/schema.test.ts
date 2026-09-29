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
          noAuthAlias: { url: "https://example.test/mcp", auth: false },
          explicitNoAuthAlias: { type: "http", url: "https://example.test/mcp", auth: false },
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
        { command: "server", auth: false },
        { url: "https://example.test", auth: true },
        { url: "https://example.test", auth: null },
        { url: "https://example.test", auth: "none" },
        { url: "https://example.test", auth: false, unknown: true },
        { url: "https://example.test", auth: { type: "none", unknown: true } },
        { type: "other", command: "server" },
        { url: "https://user:secret@example.test/mcp" },
        { url: "https://example.test", headers: { Authorization: "one\r\nx-two: secret" } },
        {
          url: "https://example.test",
          auth: { type: "oauth", registration: "pre-registered" },
        },
        // The SDK owns MCP protocol headers; a configured value would replace them.
        { url: "https://example.test", headers: { "Mcp-Session-Id": "fixed" } },
        { url: "https://example.test", headers: { "mcp-protocol-version": "2025-03-26" } },
        { url: "https://example.test", headers: { "Mcp-Param-Region": "eu" } },
      ];
      for (const value of bad)
        expect((yield* decodeMcpServer(value).pipe(Effect.flip)).kind).toBe("config");
    }),
  );

  it.effect("reports invalid known fields without echoing values or dynamic keys", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{ value: Schema.Json; field: string }> = [
        { value: { url: "https://example.test", auth: true }, field: "auth" },
        { value: { url: "https://example.test", auth: { type: "private-secret" } }, field: "auth" },
        {
          value: { command: "server", env: { PRIVATE_SECRET: { value: "private-secret" } } },
          field: "env",
        },
        {
          value: {
            url: "https://example.test",
            headers: { "private-secret": { value: "private-secret" } },
          },
          field: "headers",
        },
        { value: { command: "server", args: ["private-secret", false] }, field: "args" },
        { value: { command: "server", type: "private-secret" }, field: "type" },
        { value: { url: "https://user:private-secret@example.test" }, field: "url" },
        { value: { command: "server", transport: "private-secret" }, field: "transport" },
      ];
      for (const { value, field } of cases) {
        const error = yield* decodeMcpServer(value).pipe(Effect.flip);
        expect(error.message).toContain(`"${field}"`);
        expect(error.message).not.toContain("private-secret");
        expect(error.message.length).toBeLessThan(256);
      }
      for (const value of [
        { url: "https://example.test", auth: false, "private-secret": "private-secret" },
        { url: "https://example.test", auth: { type: "none", "private-secret": "private-secret" } },
        { command: "private-secret", url: "https://private-secret.test" },
      ]) {
        const error = yield* decodeMcpServer(value).pipe(Effect.flip);
        expect(error.message).not.toContain("private-secret");
        expect(error.message.length).toBeLessThan(256);
      }
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

  it.effect("charges exact compact JSON without counting array indices as keys", () => {
    const entry = { command: "server", args: Array.from({ length: 4_000 }, () => "a") };
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    return Effect.gen(function* () {
      yield* checkConfigBounds(entry, bytes);
      expect((yield* checkConfigBounds(entry, bytes - 1).pipe(Effect.flip)).kind).toBe("config");
    });
  });

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
