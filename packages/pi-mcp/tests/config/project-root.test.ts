import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { McpConfigStore } from "../../src/config/store.ts";
import {
  GLOBAL,
  PROJECT,
  PROJECT_ROOT,
  layerFor,
  serializedConfig,
} from "../fixtures/config-store.ts";

const inherited = {
  url: "https://global.test/mcp",
  headers: { authorization: "private-global-header" },
  auth: { type: "env", env: "GLOBAL_TOKEN" },
};

describe("project root .mcp.json", () => {
  it.effect("loads stdio and HTTP definitions without creating Pi-specific config", () => {
    const document = {
      mcpServers: {
        files: { command: "node", args: ["server.mjs"], env: { HOME: "${HOME}" } },
        nested: { type: "stdio", command: "server", cwd: "nested" },
        remote: { type: "http", url: "https://project.test/mcp" },
      },
    };
    const memory = makeInMemoryDocuments({ [PROJECT_ROOT]: document });
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      const config = yield* store.snapshot;
      expect(config.diagnostics).toEqual([]);
      expect(config.servers.files).toMatchObject({
        scope: "project",
        directory: "/project",
        enabled: true,
        definition: {
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
          cwd: "/project",
          environment: { HOME: "${HOME}" },
        },
      });
      expect(config.servers.nested?.definition).toMatchObject({ cwd: "/project/nested" });
      expect(config.servers.remote).toMatchObject({
        scope: "project",
        enabled: true,
        definition: { transport: "http", url: "https://project.test/mcp" },
      });
      yield* store.reload;
      expect(memory.documents.get(PROJECT_ROOT)).toEqual(document);
      expect([...memory.documents.keys()]).toEqual([PROJECT_ROOT]);
    }).pipe(Effect.provide(layerFor(memory)));
  });

  it.effect(
    "merges global, root, and Pi project sources in order without credential inheritance",
    () => {
      const root = {
        url: "https://shared.test/mcp",
        headers: { authorization: "private-shared-header" },
        auth: { type: "env", env: "SHARED_TOKEN" },
      };
      const memory = makeInMemoryDocuments({
        [GLOBAL]: {
          mcpServers: {
            global: { command: "global-server" },
            shared: inherited,
            replaced: inherited,
            disabled: inherited,
            invalid: inherited,
          },
          settings: { maxQueued: 0, requestTimeoutMs: 12_000, maxPerServer: 2 },
        },
        [PROJECT_ROOT]: {
          mcpServers: {
            shared: { url: "https://shared.test/mcp" },
            replaced: root,
            disabled: root,
            invalid: root,
          },
          settings: { maxConcurrent: 3, requestTimeoutMs: 20_000, maxPerServer: -1 },
        },
        [PROJECT]: {
          mcpServers: {
            local: { command: "local-server" },
            replaced: { url: "https://local.test/mcp" },
            disabled: { enabled: false },
            invalid: { url: false },
          },
          settings: { requestTimeoutMs: 30_000, maxConcurrent: -1 },
        },
      });
      return Effect.gen(function* () {
        const config = yield* (yield* McpConfigStore).snapshot;
        expect(Object.keys(config.servers).sort()).toEqual([
          "disabled",
          "global",
          "invalid",
          "local",
          "replaced",
          "shared",
        ]);
        expect(config.servers.global?.scope).toBe("global");
        expect(config.servers.local).toMatchObject({ scope: "project", directory: "/project" });
        expect(config.servers.shared?.definition).toMatchObject({
          url: "https://shared.test/mcp",
          headers: {},
          auth: { type: "oauth", implicit: true, registration: "dynamic", scopes: [] },
        });
        expect(config.servers.replaced?.definition).toMatchObject({
          url: "https://local.test/mcp",
          headers: {},
          auth: { type: "oauth", implicit: true, registration: "dynamic", scopes: [] },
        });
        expect(config.servers.disabled?.enabled).toBe(false);
        expect(config.servers.invalid?.enabled).toBe(false);
        expect(config.servers.invalid?.definition).toBeUndefined();
        expect(config.servers.invalid?.diagnostic).toContain('"url"');
        expect(serializedConfig(config)).not.toMatch(/private-|GLOBAL_TOKEN|SHARED_TOKEN/);
        expect(config.settings).toMatchObject({
          maxQueued: 0,
          requestTimeoutMs: 30_000,
          maxConcurrent: 3,
          maxPerServer: 2,
        });
      }).pipe(Effect.provide(layerFor(memory)));
    },
  );

  it.effect.each([{ enabled: false }, { url: false }])(
    "root overrides suppress global credentials even without Pi-specific config: %j",
    (entry) => {
      const memory = makeInMemoryDocuments({
        [GLOBAL]: { mcpServers: { server: inherited } },
        [PROJECT_ROOT]: { mcpServers: { server: entry } },
      });
      return Effect.gen(function* () {
        const config = yield* (yield* McpConfigStore).snapshot;
        expect(config.servers.server).toMatchObject({ scope: "project", enabled: false });
        expect(config.servers.server?.definition).toBeUndefined();
        expect(serializedConfig(config)).not.toMatch(/private-|GLOBAL_TOKEN/);
      }).pipe(Effect.provide(layerFor(memory)));
    },
  );

  it.effect(
    "keeps writes in Pi config and gives identical definitions distinct owning-file identities",
    () => {
      const entry = { command: "server", args: ["--local"] };
      const document = { mcpServers: { server: entry }, future: { preserved: true } };
      const memory = makeInMemoryDocuments({
        [GLOBAL]: { mcpServers: { server: inherited } },
        [PROJECT_ROOT]: document,
      });
      return Effect.gen(function* () {
        const store = yield* McpConfigStore;
        const original = (yield* store.snapshot).servers.server!;
        const overridden = yield* store.setServer("project", "server", entry);
        expect(overridden.servers.server?.definition).toEqual(original.definition);
        expect(overridden.servers.server?.identity).not.toBe(original.identity);
        expect(memory.documents.get(PROJECT)).toEqual({ mcpServers: { server: entry } });
        const settings = yield* store.setSettings("project", { maxQueued: 0 });
        expect(settings.servers.server?.identity).toBe(overridden.servers.server?.identity);
        expect(settings.settings.maxQueued).toBe(0);
        const revealed = yield* store.removeServer("project", "server");
        expect(revealed.servers.server?.identity).toBe(original.identity);
        expect(memory.documents.get(PROJECT_ROOT)).toEqual(document);
        memory.documents.delete(PROJECT_ROOT);
        const removed = yield* store.reload;
        expect(removed.servers.server?.scope).toBe("global");
        expect(removed.servers.server?.identity).not.toBe(original.identity);
      }).pipe(Effect.provide(layerFor(memory)));
    },
  );

  it.effect("rereads root config on reload and both global and project writes", () => {
    const memory = makeInMemoryDocuments();
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      expect((yield* store.snapshot).servers).toEqual({});
      let revision = 0;
      for (const update of [
        store.reload,
        store.setSettings("global", { maxQueued: 0 }),
        store.setSettings("project", { maxConcurrent: 2 }),
      ]) {
        revision++;
        memory.documents.set(PROJECT_ROOT, {
          mcpServers: { server: { command: `server-${revision}` } },
        });
        const config = yield* update;
        expect(config.revision).toBe(revision);
        expect(config.servers.server?.definition).toMatchObject({ command: `server-${revision}` });
        expect(config.diagnostics).toEqual([]);
      }
      memory.documents.delete(PROJECT_ROOT);
      expect((yield* store.reload).servers).toEqual({});
    }).pipe(Effect.provide(layerFor(memory)));
  });
});
