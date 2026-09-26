import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import { resolveMcpConfig, type McpConfigSource } from "../../src/config/options.ts";
import { decodeMcpDocument, type McpDecodedDocument } from "../../src/config/schema.ts";

const resolve = (
  document: McpDecodedDocument,
  source: Partial<McpConfigSource> = {},
  revision = 0,
) =>
  Path.Path.use((path) =>
    resolveMcpConfig({
      revision,
      trusted: true,
      path,
      global: {
        scope: "global",
        path: "/agent/extensions/pi-mcp.json",
        directory: "/agent",
        document,
        ...source,
      },
    }),
  );

layer(Layer.mergeAll(Path.layer, NodeCrypto.layer))("MCP configuration resolution", (it) => {
  it.effect(
    "keeps protocol omission unchanged and binds explicit legacy override to configuration identity",
    () =>
      Effect.gen(function* () {
        const document = { mcpServers: { server: { command: "fixture" } } };
        const omitted = (yield* resolve(document)).servers.server!;
        const legacy = (yield* resolve({
          mcpServers: { server: { command: "fixture", protocol: "legacy" } },
        })).servers.server!;
        expect(omitted.definition?.protocol).toBeUndefined();
        expect(legacy.definition?.protocol).toBe("legacy");
        expect(legacy.identity).not.toBe(omitted.identity);
        expect(document.mcpServers.server).toEqual({ command: "fixture" });
      }),
  );
  it.effect(
    "distinguishes explicit empty OAuth permissions while preserving omitted and nonempty normalization",
    () =>
      Effect.gen(function* () {
        const resolveScopes = (scopes?: string[]) => {
          const auth = { type: "oauth" };
          if (scopes !== undefined) Object.assign(auth, { scopes });
          return resolve({ mcpServers: { server: { url: "https://example.test/mcp", auth } } });
        };
        const omitted = (yield* resolveScopes()).servers.server!;
        const empty = (yield* resolveScopes([])).servers.server!;
        const baseline = (yield* resolveScopes(["Read", "read", "Read"])).servers.server!;
        expect(omitted.definition).toHaveProperty("auth", {
          type: "oauth",
          registration: "dynamic",
          scopes: [],
        });
        expect(empty.definition).toHaveProperty("auth", {
          type: "oauth",
          registration: "dynamic",
          scopes: [],
          explicitEmptyScopes: true,
        });
        expect(empty.identity).not.toBe(omitted.identity);
        expect(baseline.definition).toHaveProperty("auth", {
          type: "oauth",
          registration: "dynamic",
          scopes: ["Read", "read"],
        });
        expect((yield* resolveScopes(["read", "Read"])).servers.server?.identity).toBe(
          baseline.identity,
        );
        for (const malformed of [["read write"], [" read"], ['read"'], ["read\\"], ["é"]])
          expect((yield* resolveScopes(malformed)).servers.server?.enabled).toBe(false);
      }),
  );
  it.effect("keeps absent and empty tool allowlists distinct and preserves explicit denials", () =>
    Effect.gen(function* () {
      const document = yield* decodeMcpDocument({
        mcpServers: {
          all: { command: "server" },
          none: { command: "server", allowTools: [], denyTools: ["remove"] },
          denied: {
            command: "server",
            allowTools: ["remove", "read"],
            denyTools: ["remove"],
          },
        },
      });
      const resolved = yield* resolve(document);
      expect(resolved.servers.all?.definition?.allowTools).toBeUndefined();
      expect(resolved.servers.none?.definition?.allowTools).toEqual([]);
      expect(resolved.servers.none?.definition?.denyTools).toEqual(["remove"]);
      expect(resolved.servers.denied?.definition?.denyTools).toEqual(["remove"]);
    }),
  );

  it.effect.each([false, true])(
    "normalizes auth:false without changing headers, placeholders, or identity: explicit HTTP=%s",
    (explicit) =>
      Effect.gen(function* () {
        const base = {
          url: "http://127.0.0.1:3845/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        };
        const entry = explicit ? { ...base, type: "http" } : base;
        const resolveServer = (server: Schema.Json) => resolve({ mcpServers: { server } });
        const alias = (yield* resolveServer({ ...entry, auth: false })).servers.server!;
        expect(alias.enabled).toBe(true);
        expect(alias.definition).toMatchObject({
          auth: { type: "none" },
          headers: { authorization: "Bearer ${TOKEN}" },
        });
        for (const value of [entry, { ...entry, auth: { type: "none" } }]) {
          const canonical = (yield* resolveServer(value)).servers.server!;
          expect(canonical.definition).toEqual(alias.definition);
          expect(canonical.identity).toBe(alias.identity);
        }
      }),
  );

  it.effect("infers OAuth only for headerless URL servers without an explicit auth policy", () =>
    Effect.gen(function* () {
      const resolved = yield* resolve({
        mcpServers: {
          inferred: { url: "https://example.test/mcp" },
          emptyHeaders: { url: "https://example.test/mcp", headers: {} },
          disabled: { url: "https://example.test/mcp", auth: false },
          none: { url: "https://example.test/mcp", auth: { type: "none" } },
          custom: { url: "https://example.test/mcp", headers: { "X-Tenant": "fixture" } },
          environment: { url: "https://example.test/mcp", auth: { type: "env", env: "TOKEN" } },
          explicit: { url: "https://example.test/mcp", auth: { type: "oauth" } },
        },
      });
      for (const id of ["inferred", "emptyHeaders"])
        expect(resolved.servers[id]?.definition).toMatchObject({
          auth: { type: "oauth", implicit: true, registration: "dynamic", scopes: [] },
        });
      for (const id of ["disabled", "none", "custom"])
        expect(resolved.servers[id]?.definition).toMatchObject({ auth: { type: "none" } });
      expect(resolved.servers.environment?.definition).toMatchObject({ auth: { type: "env" } });
      expect(resolved.servers.explicit?.definition).toMatchObject({ auth: { type: "oauth" } });
      expect(resolved.servers.explicit?.definition).not.toHaveProperty("auth.implicit");
    }),
  );

  it.effect("normalizes owning cwd and OAuth registration without resolving values", () =>
    Effect.gen(function* () {
      const document = yield* decodeMcpDocument({
        mcpServers: {
          local: {
            type: "stdio",
            command: "npx",
            args: ["explicit-server"],
            cwd: "work",
            env: { TOKEN: "${UNRESOLVED_TOKEN}", TEXT: "$HOME" },
          },
          pre: {
            url: "https://example.test",
            auth: { type: "oauth", clientId: "public" },
          },
          metadata: {
            url: "https://example.test",
            auth: { type: "oauth", clientMetadataUrl: "https://client.test/client.json" },
          },
          dynamic: { url: "https://example.test", auth: { type: "oauth" } },
        },
      });
      const resolved = yield* resolve(document);
      expect(resolved.servers.local?.definition).toMatchObject({
        command: "npx",
        cwd: "/agent/work",
        environment: { TOKEN: "${UNRESOLVED_TOKEN}", TEXT: "$HOME" },
      });
      for (const [id, registration] of [
        ["pre", "pre-registered"],
        ["metadata", "metadata"],
        ["dynamic", "dynamic"],
      ])
        expect(resolved.servers[id!]?.definition).toMatchObject({
          auth: { registration, scopes: [] },
        });
    }),
  );

  it.effect(
    "keeps omitted compatibility settings unmaterialized and binds explicit policy to identity",
    () =>
      Effect.gen(function* () {
        const auth = { type: "oauth", issuer: "https://issuer.test", clientId: "public" };
        const resolveAuth = (config: typeof auth & { allowMissingResourceMetadata?: boolean }) =>
          resolve({ mcpServers: { server: { url: "https://example.test/mcp", auth: config } } });
        const strict = yield* resolveAuth(auth);
        const compatible = yield* resolveAuth({ ...auth, allowMissingResourceMetadata: true });
        expect(compatible.servers.server?.enabled).toBe(true);
        expect(compatible.servers.server?.definition).toMatchObject({
          auth: { allowMissingResourceMetadata: true },
        });
        expect(compatible.servers.server?.identity).not.toBe(strict.servers.server?.identity);
        expect(strict.servers.server?.definition).not.toHaveProperty(
          "auth.allowMissingResourceMetadata",
        );
        const inferred = yield* resolve({
          mcpServers: {
            server: {
              url: "https://example.test/mcp",
              auth: { type: "oauth", allowMissingResourceMetadata: true },
            },
          },
        });
        expect(inferred.servers.server?.enabled).toBe(true);
        expect(inferred.diagnostics).toEqual([]);
        const disabled = yield* resolveAuth({ ...auth, allowMissingResourceMetadata: false });
        expect(disabled.servers.server?.identity).not.toBe(strict.servers.server?.identity);
      }),
  );

  it.effect(
    "binds identities to owning file, server id, complete auth and unresolved definitions",
    () =>
      Effect.gen(function* () {
        const definition = {
          url: "https://example.test/mcp",
          headers: { "x-first": "a", "x-second": "${TOKEN}" },
          auth: { type: "oauth", clientId: "client", issuer: "https://issuer.test" },
        };
        const document = yield* decodeMcpDocument({
          mcpServers: { server: definition, other: definition },
        });
        const original = yield* resolve(document, {}, 1);
        expect(original.servers.server?.identity).not.toBe(original.servers.other?.identity);
        const moved = yield* resolve(document, { path: "/different/extensions/pi-mcp.json" }, 1);
        expect(original.servers.server?.identity).not.toBe(moved.servers.server?.identity);
        const rescoped = yield* resolve(document, { scope: "project" }, 1);
        expect(original.servers.server?.identity).not.toBe(rescoped.servers.server?.identity);
        const reordered = yield* decodeMcpDocument({
          mcpServers: {
            server: {
              ...definition,
              headers: { "x-second": "${TOKEN}", "x-first": "a" },
            },
          },
        });
        expect((yield* resolve(reordered, {}, 1)).servers.server?.identity).toBe(
          original.servers.server?.identity,
        );
        const changed = yield* decodeMcpDocument({
          mcpServers: {
            server: {
              ...definition,
              auth: { ...definition.auth, issuer: "https://other-issuer.test" },
            },
          },
        });
        expect((yield* resolve(changed, {}, 1)).servers.server?.identity).not.toBe(
          original.servers.server?.identity,
        );
        const interpolation = yield* decodeMcpDocument({
          mcpServers: {
            server: {
              ...definition,
              headers: { "x-first": "a", "x-second": "${OTHER_TOKEN}" },
            },
          },
        });
        expect((yield* resolve(interpolation, {}, 1)).servers.server?.identity).not.toBe(
          original.servers.server?.identity,
        );
      }),
  );
});
