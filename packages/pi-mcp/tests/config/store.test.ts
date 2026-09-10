import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  AgentDirectory,
  JsonDocumentError,
  JsonDocumentStore,
  ProcessCoordinator,
  type AtomicJsonDocumentStoreContract,
} from "pi-cosmic-core";
import { makeInMemoryDocuments, type InMemoryDocuments } from "pi-cosmic-core/testing";
import type { McpEffectiveServer, McpResolvedConfig } from "../../src/config/model.ts";
import { DEFAULT_MCP_SETTINGS, MCP_CONFIG_LIMITS } from "../../src/config/schema.ts";
import { McpConfigStore } from "../../src/config/store.ts";

const serializedConfig = (config: McpResolvedConfig | McpEffectiveServer | undefined) =>
  JSON.stringify(config);
const GLOBAL = "/agent/extensions/pi-mcp.json";
const PROJECT = `/project/${CONFIG_DIR_NAME}/extensions/pi-mcp.json`;
const stdio = { transport: "stdio", command: "server" };
const layerFor = (
  memory: InMemoryDocuments,
  projectTrusted = true,
  service: AtomicJsonDocumentStoreContract = memory.service,
) =>
  McpConfigStore.layer({ cwd: "/project", projectTrusted }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(JsonDocumentStore, service),
        AgentDirectory.layer("/agent"),
        Path.layer,
        NodeCrypto.layer,
      ),
    ),
  );

const rawDocuments = (initial: Record<string, string>) => {
  const files = new Map(Object.entries(initial));
  const read = (path: string) =>
    Effect.gen(function* () {
      const source = files.get(path);
      if (source === undefined)
        return yield* Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "read" }),
        );
      return source;
    });
  const fs = FileSystem.makeNoop({
    readFileString: read,
    stream: (path, options) =>
      read(path).pipe(
        Effect.map((source) => {
          const bytes = new TextEncoder().encode(source);
          return Stream.make(bytes.subarray(0, Number(options?.bytesToRead ?? bytes.length)));
        }),
        Stream.unwrap,
      ),
    chmod: () => Effect.void,
    makeDirectory: () => Effect.void,
    makeTempFile: () => Effect.succeed("/temporary/config.json"),
    writeFileString: (path, source) => Effect.sync(() => void files.set(path, source)),
    rename: (from, to) =>
      Effect.sync(() => {
        files.set(to, files.get(from)!);
        files.delete(from);
      }),
  });
  return {
    files,
    layer: McpConfigStore.layer({ cwd: "/project", projectTrusted: true }).pipe(
      Layer.provide(
        Layer.mergeAll(
          JsonDocumentStore.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, fs),
                Path.layer,
                ProcessCoordinator.layer,
              ),
            ),
          ),
          AgentDirectory.layer("/agent"),
          Path.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  };
};
const paddedDocument = (bytes: number) => {
  const source = JSON.stringify({ version: 1, future: "é😀", servers: { server: stdio } });
  return source + " ".repeat(bytes - new TextEncoder().encode(source).byteLength);
};

describe("trusted MCP configuration store", () => {
  it.effect.each(["global", "project"] as const)(
    "bounds initial %s reads and reloads at the exact UTF-8 byte limit",
    (scope) => {
      const target = scope === "global" ? GLOBAL : PROJECT;
      const fixture = rawDocuments({ [target]: paddedDocument(MCP_CONFIG_LIMITS.bytes + 1) });
      return Effect.gen(function* () {
        const store = yield* McpConfigStore;
        expect((yield* store.snapshot).diagnostics.length).toBeGreaterThan(0);
        expect((yield* store.snapshot).servers.server?.enabled).not.toBe(true);
        fixture.files.set(target, paddedDocument(MCP_CONFIG_LIMITS.bytes));
        expect((yield* store.reload).servers.server?.enabled).toBe(true);
        fixture.files.set(target, paddedDocument(MCP_CONFIG_LIMITS.bytes + 1));
        expect((yield* store.reload).servers.server?.enabled).not.toBe(true);
        fixture.files.delete(target);
        const missing = yield* store.reload;
        expect(missing.diagnostics).toEqual([]);
        expect(missing.servers).toEqual({});
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect.each(["global", "project"] as const)(
    "rejects an oversized latest %s document inside the locked write without publication",
    (scope) => {
      const target = scope === "global" ? GLOBAL : PROJECT;
      const fixture = rawDocuments({ [target]: '{"version":1}' });
      const published: McpResolvedConfig[] = [];
      return Effect.gen(function* () {
        const store = yield* McpConfigStore;
        yield* store.subscribe((next) =>
          Effect.sync(() => {
            published.push(next);
          }),
        );
        const before = yield* store.snapshot;
        const oversized = paddedDocument(MCP_CONFIG_LIMITS.bytes + 1);
        fixture.files.set(target, oversized);
        expect((yield* store.setSettings(scope, { enabled: false }).pipe(Effect.flip)).kind).toBe(
          "config",
        );
        expect(yield* store.snapshot).toBe(before);
        expect(published).toEqual([before]);
        expect(fixture.files.get(target)).toBe(oversized);
        fixture.files.set(target, '{"version":1}');
        expect((yield* store.setSettings(scope, { maxQueued: 0 })).settings.maxQueued).toBe(0);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("does not persist a replacement that formatting would push over the byte limit", () => {
    const preserved = Object.fromEntries(
      Array.from({ length: 22_000 }, (_, index) => [`k${index}`, "x".repeat(30)]),
    );
    const source = JSON.stringify({ version: 1, extra: { nested: { preserved } } });
    const fixture = rawDocuments({ [GLOBAL]: source });
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      const before = yield* store.snapshot;
      expect(before.diagnostics).toEqual([]);
      expect((yield* store.setSettings("global", { enabled: false }).pipe(Effect.flip)).kind).toBe(
        "config",
      );
      expect(yield* store.snapshot).toBe(before);
      expect(fixture.files.get(GLOBAL)).toBe(source);
      expect((yield* store.reload).diagnostics).toEqual([]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect(
    "rejects deeply nested bounded JSON through the existing config guard without defects or mutation",
    () => {
      const source =
        '{"version":1,"private":' + "[".repeat(10_000) + "0" + "]".repeat(10_000) + "}";
      const fixture = rawDocuments({ [GLOBAL]: source });
      return Effect.gen(function* () {
        const store = yield* McpConfigStore;
        expect((yield* store.snapshot).diagnostics.length).toBeGreaterThan(0);
        expect(
          (yield* store.setSettings("global", { enabled: false }).pipe(Effect.flip)).kind,
        ).toBe("config");
        expect(fixture.files.get(GLOBAL)).toBe(source);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
  it.effect(
    "never touches project documents in an untrusted session, including rejected writes",
    () => {
      const memory = makeInMemoryDocuments({
        [GLOBAL]: { version: 1, servers: { server: stdio } },
        [PROJECT]: { version: 1, servers: { project: stdio } },
      });
      const touched: string[] = [];
      const service: AtomicJsonDocumentStoreContract = {
        ...memory.service,
        exists: (path) => {
          touched.push(path);
          return memory.service.exists(path);
        },
        readObject: (path, options) => {
          touched.push(path);
          return memory.service.readObject(path, options);
        },
        modifyObject: (path, modify, options) => {
          touched.push(path);
          return memory.service.modifyObject(path, modify, options);
        },
        writeObject: (path, document) => {
          touched.push(path);
          return memory.service.writeObject(path, document);
        },
        updateObject: (path, update, options) => {
          touched.push(path);
          return memory.service.updateObject(path, update, options);
        },
      };
      return Effect.gen(function* () {
        const store = yield* McpConfigStore;
        expect((yield* store.snapshot).trusted).toBe(false);
        expect(Object.keys((yield* store.snapshot).servers)).toEqual(["server"]);
        yield* store.reload;
        for (const change of [
          store.setServer("project", "server", stdio),
          store.removeServer("project", "server"),
          store.setSettings("project", { enabled: false }),
        ])
          expect((yield* change.pipe(Effect.flip)).kind).toBe("denied");
        yield* store.setSettings("global", { maxQueued: 0 });
        expect(touched.length).toBeGreaterThan(0);
        expect(touched.every((path) => path === GLOBAL)).toBe(true);
      }).pipe(Effect.provide(layerFor(memory, false, service)));
    },
  );

  it.effect("replaces entries as a whole and never inherits global credentials", () => {
    const memory = makeInMemoryDocuments({
      [GLOBAL]: {
        version: 1,
        servers: {
          server: {
            transport: "http",
            url: "https://global.test",
            headers: { authorization: { value: "private" } },
            auth: { type: "env", env: "GLOBAL_TOKEN" },
          },
        },
      },
      [PROJECT]: {
        version: 1,
        servers: { server: { transport: "http", url: "https://project.test" } },
      },
    });
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      const server = (yield* store.snapshot).servers.server;
      expect(server).toMatchObject({
        scope: "project",
        directory: "/project",
        enabled: true,
        definition: { headers: {}, auth: { type: "none" } },
      });
      expect(serializedConfig(server)).not.toContain("private");
      yield* store.setServer("project", "server", { enabled: false });
      expect((yield* store.snapshot).servers.server?.enabled).toBe(false);
      memory.documents.set(PROJECT, {
        version: 1,
        servers: { server: { transport: "http", url: false } },
      });
      const malformed = yield* store.reload;
      expect(malformed.servers.server).toMatchObject({ enabled: false, scope: "project" });
      expect(malformed.servers.server?.definition).toBeUndefined();
      expect(malformed.servers.server?.diagnostic).toBeDefined();
      expect(serializedConfig(malformed)).not.toContain("GLOBAL_TOKEN");
      yield* store.removeServer("project", "server");
      expect((yield* store.snapshot).servers.server?.scope).toBe("global");
    }).pipe(Effect.provide(layerFor(memory)));
  });

  it.effect(
    "fails closed on unreadable or malformed project documents, including global writes",
    () => {
      const memory = makeInMemoryDocuments({
        [GLOBAL]: { version: 1, servers: { server: stdio } },
      });
      let unreadable = true;
      const service: AtomicJsonDocumentStoreContract = {
        ...memory.service,
        readObject: (path) =>
          path === PROJECT && unreadable
            ? Effect.fail(
                new JsonDocumentError({ operation: "read", path, message: "secret diagnostic" }),
              )
            : memory.service.readObject(path),
      };
      return Effect.gen(function* () {
        const store = yield* McpConfigStore;
        expect((yield* store.snapshot).servers.server?.enabled).toBe(false);
        yield* store.setSettings("global", { maxQueued: 0 });
        expect((yield* store.snapshot).servers.server?.enabled).toBe(false);
        expect(serializedConfig(yield* store.snapshot)).not.toContain("secret diagnostic");
        unreadable = false;
        memory.documents.set(PROJECT, { version: 99, servers: {} });
        expect((yield* store.reload).servers.server?.enabled).toBe(false);
        memory.documents.set(PROJECT, { version: 1, servers: [] });
        expect((yield* store.reload).servers.server?.enabled).toBe(false);
        memory.documents.delete(PROJECT);
        expect((yield* store.reload).servers.server?.enabled).toBe(true);
      }).pipe(Effect.provide(layerFor(memory, true, service)));
    },
  );

  it.effect("merges valid raw settings fields over global values, never project defaults", () => {
    const memory = makeInMemoryDocuments({
      [GLOBAL]: {
        version: 1,
        settings: { requestTimeoutMs: 12_000, maxQueued: 0, enabled: false },
      },
      [PROJECT]: { version: 1, settings: { maxConcurrent: 2, requestTimeoutMs: -1 } },
    });
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      expect((yield* store.snapshot).settings).toEqual({
        ...DEFAULT_MCP_SETTINGS,
        requestTimeoutMs: 12_000,
        maxQueued: 0,
        enabled: false,
        maxConcurrent: 2,
      });
      expect(
        (yield* store.setSettings("project", { requestTimeoutMs: 20_000 })).settings
          .requestTimeoutMs,
      ).toBe(20_000);
      expect(
        (yield* store.setSettings("project", { maxConcurrent: 0 }).pipe(Effect.flip)).kind,
      ).toBe("invalid-input");
    }).pipe(Effect.provide(layerFor(memory)));
  });

  it.effect(
    "preserves unrelated fields and concurrent external changes under atomic modification",
    () => {
      const memory = makeInMemoryDocuments({
        [GLOBAL]: { version: 1, future: { secret: false }, settings: { futureSetting: true } },
      });
      return Effect.gen(function* () {
        const store = yield* McpConfigStore;
        memory.injectBeforeNextUpdate((document) => ({
          ...document,
          external: true,
          servers: { sibling: stdio },
        }));
        yield* store.setServer("global", "new", stdio);
        yield* store.setSettings("global", { maxQueued: 0 });
        yield* store.removeServer("global", "new");
        expect(memory.documents.get(GLOBAL)).toEqual({
          version: 1,
          future: { secret: false },
          external: true,
          servers: { sibling: stdio },
          settings: { futureSetting: true, maxQueued: 0 },
        });
        expect((yield* store.snapshot).revision).toBe(3);
      }).pipe(Effect.provide(layerFor(memory)));
    },
  );

  it.effect("rejects writes to unknown document versions without rewriting them", () => {
    const memory = makeInMemoryDocuments({ [GLOBAL]: { version: 2, future: true } });
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      expect((yield* store.setServer("global", "server", stdio).pipe(Effect.flip)).kind).toBe(
        "config",
      );
      expect((yield* store.snapshot).revision).toBe(0);
      expect(memory.documents.get(GLOBAL)).toEqual({ version: 2, future: true });
    }).pipe(Effect.provide(layerFor(memory)));
  });

  it.effect("does not publish failed writes or replace the last successful snapshot", () => {
    const memory = makeInMemoryDocuments({ [GLOBAL]: { version: 1 } });
    const published: McpResolvedConfig[] = [];
    const service: AtomicJsonDocumentStoreContract = {
      ...memory.service,
      modifyObject: (path, modify) =>
        memory.service.modifyObject(path, (document) =>
          modify(document).pipe(
            Effect.andThen(
              Effect.fail(new JsonDocumentError({ operation: "write", path, message: "failed" })),
            ),
          ),
        ),
    };
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      yield* store.subscribe((next) =>
        Effect.sync(() => {
          published.push(next);
        }),
      );
      const before = yield* store.snapshot;
      expect((yield* store.setSettings("global", { enabled: false }).pipe(Effect.flip)).kind).toBe(
        "config",
      );
      expect(yield* store.snapshot).toBe(before);
      expect(published).toEqual([before]);
      expect(memory.documents.get(GLOBAL)).toEqual({ version: 1 });
    }).pipe(Effect.provide(layerFor(memory, true, service)));
  });

  it.effect("keeps rename and publication aligned when interrupted inside afterCommit", () => {
    const memory = makeInMemoryDocuments({ [GLOBAL]: { version: 1 } });
    const published: McpResolvedConfig[] = [];
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* store.subscribe((next) =>
        Effect.gen(function* () {
          if (next.revision === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          published.push(next);
        }),
      );
      const writing = yield* store.setSettings("global", { maxQueued: 0 }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      expect(memory.documents.get(GLOBAL)?.settings).toEqual({ maxQueued: 0 });
      const interrupting = yield* Fiber.interrupt(writing).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      expect((yield* store.snapshot).settings.maxQueued).toBe(0);
      expect(published.at(-1)?.revision).toBe(1);
      expect(published.at(-1)).toBe(yield* store.snapshot);
      expect(Object.isFrozen(published.at(-1)?.settings)).toBe(true);
    }).pipe(Effect.provide(layerFor(memory)));
  });

  it.effect("interrupts preparation without committing and permits a subsequent update", () => {
    const memory = makeInMemoryDocuments({ [GLOBAL]: { version: 1 } });
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      memory.blockNextUpdateBeforeCommit(started, release);
      const writing = yield* store.setSettings("global", { maxQueued: 0 }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(writing);
      expect(memory.documents.get(GLOBAL)).toEqual({ version: 1 });
      expect((yield* store.snapshot).revision).toBe(0);
      expect((yield* store.setSettings("global", { maxConcurrent: 2 })).revision).toBe(1);
    }).pipe(Effect.provide(layerFor(memory)));
  });

  it.effect("serializes writes and reloads through the same publication lock", () => {
    const memory = makeInMemoryDocuments({ [GLOBAL]: { version: 1 } });
    const revisions: number[] = [];
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      yield* store.subscribe((config) =>
        Effect.sync(() => {
          revisions.push(config.revision);
        }),
      );
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      memory.blockNextUpdateAtCommit(started, release);
      const first = yield* store
        .setSettings("global", { maxConcurrent: 2 })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const second = yield* store.setSettings("global", { maxQueued: 0 }).pipe(Effect.forkScoped);
      const reloading = yield* store.reload.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(reloading);
      expect((yield* store.snapshot).settings).toMatchObject({ maxConcurrent: 2, maxQueued: 0 });
      expect(revisions).toEqual([0, 1, 2, 3]);
    }).pipe(Effect.provide(layerFor(memory)));
  });

  it.effect("replaces the single subscriber without an old scope revoking the new owner", () => {
    const memory = makeInMemoryDocuments();
    const first: number[] = [];
    const second: number[] = [];
    return Effect.gen(function* () {
      const store = yield* McpConfigStore;
      const old = yield* Scope.make();
      yield* store
        .subscribe((next) =>
          Effect.sync(() => {
            first.push(next.revision);
          }),
        )
        .pipe(Scope.provide(old));
      yield* store.subscribe((next) =>
        Effect.sync(() => {
          second.push(next.revision);
        }),
      );
      yield* Scope.close(old, Exit.void);
      yield* store.setSettings("global", { maxQueued: 0 });
      expect(first).toEqual([0]);
      expect(second).toEqual([0, 1]);
    }).pipe(Effect.provide(layerFor(memory)));
  });
});
