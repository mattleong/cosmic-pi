// @effect-diagnostics effect/strictEffectProvide:off
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { JsonDocumentStore } from "../src/platform/json-document.ts";

function documentLayer(initial: Readonly<Record<string, string>>) {
  const files = new Map(Object.entries(initial));
  let sequence = 0;
  const fileSystem = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(files.has(String(path))),
    makeDirectory: () => Effect.void,
    makeTempFile: () => Effect.sync(() => `/tmp/document-${sequence++}.json`),
    readFileString: (path) => Effect.succeed(files.get(String(path)) ?? ""),
    remove: (path) => Effect.sync(() => void files.delete(String(path))),
    rename: (from, to) =>
      Effect.sync(() => {
        const value = files.get(String(from));
        if (value !== undefined) files.set(String(to), value);
        files.delete(String(from));
      }),
    writeFileString: (path, value) => Effect.sync(() => void files.set(String(path), value)),
  });
  return {
    files,
    layer: JsonDocumentStore.layer.pipe(Layer.provide(Layer.merge(fileSystem, Path.layer))),
  };
}

it.effect("reads and atomically writes JSON object documents", () => {
  const harness = documentLayer({
    "/config.json": '{"known":true,"unknown":"keep"}',
  });
  return Effect.gen(function* () {
    const store = yield* JsonDocumentStore;
    const document = yield* store.readObject("/config.json");
    expect(document?.unknown).toBe("keep");
    yield* store.writeObject("/config.json", { ...document, known: false });
    expect(harness.files.get("/config.json")).toContain('"unknown": "keep"');
    expect([...harness.files.keys()]).toEqual(["/config.json"]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("serializes read-modify-write updates", () => {
  const harness = documentLayer({ "/auth.json": '{"alpha":1}' });
  return Effect.gen(function* () {
    const store = yield* JsonDocumentStore;
    yield* Effect.all(
      [
        store.updateObject("/auth.json", (document) => ({ ...document, beta: 2 })),
        store.updateObject("/auth.json", (document) => ({ ...document, gamma: 3 })),
      ],
      { concurrency: "unbounded" },
    );
    expect(yield* store.readObject("/auth.json")).toEqual({
      alpha: 1,
      beta: 2,
      gamma: 3,
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect("fails closed when the latest document cannot be decoded", () => {
  const harness = documentLayer({ "/auth.json": "not-json" });
  return Effect.gen(function* () {
    const store = yield* JsonDocumentStore;
    const result = yield* Effect.result(
      store.updateObject("/auth.json", (document) => ({ ...document, xai: {} })),
    );
    expect(result._tag).toBe("Failure");
    expect(harness.files.get("/auth.json")).toBe("not-json");
  }).pipe(Effect.provide(harness.layer));
});
