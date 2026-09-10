import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { resolveMcpConfig, type McpConfigSource } from "../../src/config/options.ts";
import { decodeMcpDocument } from "../../src/config/schema.ts";

const globalSource = (document: NonNullable<McpConfigSource["document"]>): McpConfigSource => ({
  scope: "global",
  path: "/agent/extensions/pi-mcp.json",
  directory: "/agent",
  document,
});

describe("MCP configuration resolution", () => {
  it.effect("keeps absent and empty tool allowlists distinct and preserves explicit denials", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const document = yield* decodeMcpDocument({
        version: 1,
        servers: {
          all: { transport: "stdio", command: "server" },
          none: { transport: "stdio", command: "server", allowTools: [], denyTools: ["remove"] },
          denied: {
            transport: "stdio",
            command: "server",
            allowTools: ["remove", "read"],
            denyTools: ["remove"],
          },
        },
      });
      const resolved = yield* resolveMcpConfig({
        revision: 0,
        trusted: true,
        global: globalSource(document),
        path,
      });
      expect(resolved.servers.all?.definition?.allowTools).toBeUndefined();
      expect(resolved.servers.none?.definition?.allowTools).toEqual([]);
      expect(resolved.servers.none?.definition?.denyTools).toEqual(["remove"]);
      expect(resolved.servers.denied?.definition?.denyTools).toEqual(["remove"]);
    }).pipe(Effect.provide([Path.layer, NodeCrypto.layer])),
  );

  it.effect("normalizes owning cwd and OAuth registration without resolving bindings", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const document = yield* decodeMcpDocument({
        version: 1,
        servers: {
          local: {
            transport: "stdio",
            command: "npx",
            args: ["explicit-server"],
            cwd: "work",
            environment: { TOKEN: { env: "UNRESOLVED_TOKEN" }, TEXT: { value: "$HOME" } },
          },
          pre: {
            transport: "http",
            url: "https://example.test",
            auth: { type: "oauth", clientId: "public" },
          },
          metadata: {
            transport: "http",
            url: "https://example.test",
            auth: { type: "oauth", clientMetadataUrl: "https://client.test/client.json" },
          },
          dynamic: { transport: "http", url: "https://example.test", auth: { type: "oauth" } },
        },
      });
      const resolved = yield* resolveMcpConfig({
        revision: 0,
        trusted: true,
        global: globalSource(document),
        path,
      });
      expect(resolved.servers.local?.definition).toMatchObject({
        command: "npx",
        cwd: "/agent/work",
        environment: { TOKEN: { env: "UNRESOLVED_TOKEN" }, TEXT: { value: "$HOME" } },
      });
      for (const [id, registration] of [
        ["pre", "pre-registered"],
        ["metadata", "metadata"],
        ["dynamic", "dynamic"],
      ])
        expect(resolved.servers[id!]?.definition).toMatchObject({
          auth: { registration, scopes: [] },
        });
    }).pipe(Effect.provide([Path.layer, NodeCrypto.layer])),
  );

  it.effect(
    "binds identities to owning file, server id, complete auth and unresolved definitions",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const definition = {
          transport: "http",
          url: "https://example.test/mcp",
          headers: { "x-first": { value: "a" }, "x-second": { env: "TOKEN" } },
          auth: { type: "oauth", clientId: "client", issuer: "https://issuer.test" },
        };
        const document = yield* decodeMcpDocument({
          version: 1,
          servers: { server: definition, other: definition },
        });
        const resolve = (source: McpConfigSource) =>
          resolveMcpConfig({ revision: 1, trusted: true, global: source, path });
        const original = yield* resolve(globalSource(document));
        expect(original.servers.server?.identity).not.toBe(original.servers.other?.identity);
        const moved = yield* resolve({
          ...globalSource(document),
          path: "/different/extensions/pi-mcp.json",
        });
        expect(original.servers.server?.identity).not.toBe(moved.servers.server?.identity);
        const rescoped = yield* resolve({ ...globalSource(document), scope: "project" });
        expect(original.servers.server?.identity).not.toBe(rescoped.servers.server?.identity);
        const reordered = yield* decodeMcpDocument({
          version: 1,
          servers: {
            server: {
              ...definition,
              headers: { "x-second": { env: "TOKEN" }, "x-first": { value: "a" } },
            },
          },
        });
        expect((yield* resolve(globalSource(reordered))).servers.server?.identity).toBe(
          original.servers.server?.identity,
        );
        const changed = yield* decodeMcpDocument({
          version: 1,
          servers: {
            server: {
              ...definition,
              auth: { ...definition.auth, issuer: "https://other-issuer.test" },
            },
          },
        });
        expect((yield* resolve(globalSource(changed))).servers.server?.identity).not.toBe(
          original.servers.server?.identity,
        );
        const binding = yield* decodeMcpDocument({
          version: 1,
          servers: {
            server: {
              ...definition,
              headers: { "x-first": { value: "a" }, "x-second": { env: "OTHER_TOKEN" } },
            },
          },
        });
        expect((yield* resolve(globalSource(binding))).servers.server?.identity).not.toBe(
          original.servers.server?.identity,
        );
      }).pipe(Effect.provide([Path.layer, NodeCrypto.layer])),
  );
});
