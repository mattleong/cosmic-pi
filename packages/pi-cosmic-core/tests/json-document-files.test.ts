import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { JsonDocumentStore } from "../src/platform/json-document.ts";
import { JsonDocumentLock } from "../src/platform/json-document-lock.ts";
import { fileLayer } from "../src/platform/node.ts";
import { nodeFsPromises as fs, nodePath as path } from "../src/platform/node-builtins.ts";
import { killChild, spawnIpcChild, temporaryDirectory } from "../src/testing/ipc-child.ts";
import { incrementDocumentCount } from "./support/json-documents.ts";

vi.setConfig({ testTimeout: 30_000 });

const childScript = fileURLToPath(new URL("./fixtures/json-document-child.ts", import.meta.url));
const spawnWriter = (documentPath: string, mode: "increment" | "hold", rounds = 1) =>
  spawnIpcChild(childScript, [documentPath, mode, String(rounds)], { timeout: "20 seconds" });

const promise = <A>(evaluate: () => Promise<A>) => Effect.promise(evaluate);
const readJson = (file: string) => JsonDocumentStore.use((store) => store.readObject(file));
const isSymlink = (file: string) =>
  promise(() => fs.lstat(file)).pipe(Effect.map((stat) => stat.isSymbolicLink()));
const addField = (documentPath: string, field: string) =>
  JsonDocumentStore.use((store) =>
    store.modifyObject(documentPath, (document) =>
      Effect.succeed({ value: undefined, document: { ...document, [field]: true } }),
    ),
  );
const quickLockStore = JsonDocumentStore.layerWith(
  JsonDocumentLock.layerWith({ timeout: "200 millis" }),
).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)));

it.live("updates a symlinked document's target and keeps the link", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("cosmic-json-symlink-");
    const real = path.join(root, "dotfiles", "pi");
    yield* promise(() => fs.mkdir(real, { recursive: true }));
    yield* promise(() => fs.writeFile(path.join(real, "settings.json"), '{"kept":true}\n'));
    yield* promise(() => fs.mkdir(path.join(root, "agent")));
    const linked = path.join(root, "agent", "settings.json");
    yield* promise(() => fs.symlink("../dotfiles/pi/settings.json", linked));

    yield* addField(linked, "added");
    yield* JsonDocumentStore.use((store) => store.writeObject(linked, { replaced: true }));
    yield* addField(linked, "again");

    expect(yield* isSymlink(linked)).toBe(true);
    expect(yield* promise(() => fs.readlink(linked))).toBe("../dotfiles/pi/settings.json");
    expect(yield* readJson(path.join(real, "settings.json"))).toEqual({
      replaced: true,
      again: true,
    });
    expect(yield* promise(() => fs.readdir(real))).toEqual([
      ".settings.json.lock",
      "settings.json",
    ]);
    expect(yield* promise(() => fs.readdir(path.join(root, "agent")))).toEqual(["settings.json"]);
  }).pipe(Effect.provide(fileLayer), Effect.scoped),
);

it.live("resolves a relative link from its real directory and creates a dangling target", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("cosmic-json-dangling-");
    const deep = path.join(root, "store", "deep");
    yield* promise(() => fs.mkdir(deep, { recursive: true }));
    yield* promise(() => fs.symlink(deep, path.join(root, "alias")));
    yield* promise(() => fs.symlink("../shared/config.json", path.join(deep, "config.json")));
    const throughAlias = path.join(root, "alias", "config.json");

    yield* addField(throughAlias, "created");

    expect(yield* isSymlink(path.join(deep, "config.json"))).toBe(true);
    expect(yield* readJson(path.join(root, "store", "shared", "config.json"))).toEqual({
      created: true,
    });
  }).pipe(Effect.provide(fileLayer), Effect.scoped),
);

it.live("fails a write through a symlink loop without touching the links", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("cosmic-json-loop-");
    yield* promise(() => fs.symlink("b.json", path.join(root, "a.json")));
    yield* promise(() => fs.symlink("a.json", path.join(root, "b.json")));

    const failure = yield* Effect.flip(addField(path.join(root, "a.json"), "never"));

    expect(failure.operation).toBe("resolve");
    expect(yield* isSymlink(path.join(root, "a.json"))).toBe(true);
  }).pipe(Effect.provide(fileLayer), Effect.scoped),
);

it.live("keeps every concurrent update from separate processes", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("cosmic-json-processes-");
    const document = path.join(root, "counter.json");
    const writer = yield* spawnWriter(document, "increment", 30);
    yield* writer.wait("started");
    yield* Effect.repeat(incrementDocumentCount(document), { times: 29 });
    yield* writer.wait("finished");

    expect(yield* readJson(document)).toEqual({ count: 60 });
    expect(yield* promise(() => fs.readdir(root))).toEqual([".counter.json.lock", "counter.json"]);
    expect(yield* promise(() => fs.readdir(path.join(root, ".counter.json.lock")))).toEqual([]);
  }).pipe(Effect.provide(fileLayer), Effect.scoped),
);

it.live("fails as locked while another process holds the real path, then reclaims a crash", () =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("cosmic-json-busy-");
    const real = path.join(root, "config.json");
    const linked = path.join(root, "linked.json");
    yield* promise(() => fs.writeFile(real, "{}\n"));
    yield* promise(() => fs.symlink("config.json", linked));
    const holder = yield* spawnWriter(real, "hold");
    yield* holder.wait("locked");

    const busy = yield* Effect.flip(addField(linked, "blocked"));
    expect(busy.operation).toBe("lock");
    expect(yield* readJson(real)).toEqual({});

    yield* killChild(holder.child);
    yield* addField(linked, "after-crash");

    expect(yield* readJson(real)).toEqual({ "after-crash": true });
  }).pipe(Effect.provide(quickLockStore), Effect.scoped),
);
