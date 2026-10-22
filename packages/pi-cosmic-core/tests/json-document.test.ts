import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import {
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "../src/platform/json-document.ts";
import { provideBuiltLayer } from "../testing.ts";
import { inProcessDocumentLock } from "./support/json-documents.ts";

const toBytes = (source: string | Uint8Array) =>
  source instanceof Uint8Array ? source : new TextEncoder().encode(source);

function documentLayer(initial: Readonly<Record<string, string | Uint8Array>>) {
  const files = new Map(Object.entries(initial));
  let sequence = 0;
  const fileSystem = {
    ...FileSystem.make(
      FileSystem.makeNoop({
        readFile: (path) =>
          Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => toBytes(files.get(path) ?? "")))),
        chmod: () => Effect.void,
        makeDirectory: () => Effect.void,
        makeTempFile: () =>
          Effect.sync(() => {
            const path = `/tmp/document-${sequence++}/value.json`;
            files.set(path, "");
            return path;
          }),
        writeFile: (path, bytes) =>
          Effect.sync(() => void files.set(path, new TextDecoder().decode(bytes))),
        remove: (path) =>
          Effect.sync(() => {
            for (const candidate of files.keys()) {
              if (candidate === path || candidate.startsWith(`${path}/`)) files.delete(candidate);
            }
          }),
        rename: (from, to) =>
          Effect.sync(() => {
            const value = files.get(from);
            if (value !== undefined) files.set(to, value);
            files.delete(from);
          }),
      }),
    ),
  };
  return {
    files,
    fileSystem,
    layer: JsonDocumentStore.layerWith(inProcessDocumentLock).pipe(
      Layer.provide(Layer.merge(Layer.succeed(FileSystem.FileSystem, fileSystem), Path.layer)),
    ),
  };
}

const modify = <A>(modification: JsonDocumentModification<A>) =>
  JsonDocumentStore.use((store) =>
    store.modifyObject("/config.json", () => Effect.succeed(modification)),
  );

const trackedModification = (document: JsonObject) => {
  const state = { mutated: false, published: false };
  const change = () => {
    state.mutated = true;
    return Effect.succeed({
      value: undefined,
      document,
      afterCommit: Effect.sync(() => {
        state.published = true;
      }),
    });
  };
  return { state, change };
};

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
  }).pipe(provideBuiltLayer(harness.layer));
});

it.effect("fails closed when the latest document cannot be decoded", () => {
  const harness = documentLayer({ "/auth.json": "not-json" });
  return Effect.gen(function* () {
    const { state, change } = trackedModification({ xai: {} });
    const store = yield* JsonDocumentStore;
    const result = yield* Effect.result(store.modifyObject("/auth.json", change));
    expect(result._tag).toBe("Failure");
    expect(state).toEqual({ mutated: false, published: false });
    expect(harness.files.get("/auth.json")).toBe("not-json");
  }).pipe(provideBuiltLayer(harness.layer));
});

it.effect("rejects non-JSON values instead of coercing persisted data", () => {
  const harness = documentLayer({});
  return Effect.gen(function* () {
    const store = yield* JsonDocumentStore;
    const invalidDocument: Schema.MutableJsonObject = { coerced: Number.NaN };
    Object.defineProperty(invalidDocument, "dropped", {
      value: undefined,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const result = yield* Effect.result(store.writeObject("/config.json", invalidDocument));
    expect(result._tag).toBe("Failure");
    if (Result.isFailure(result)) expect(result.failure.operation).toBe("encode");
    expect(harness.files.has("/config.json")).toBe(false);
  }).pipe(provideBuiltLayer(harness.layer));
});

it.effect(
  "interrupts preparation before commit and cleans only the owned temporary directory",
  () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>();
      const harness = documentLayer({ "/config.json": '{"enabled":false}' });
      let renames = 0;
      let afterCommits = 0;
      const writeFileString = harness.fileSystem.writeFileString;
      harness.fileSystem.rename = () => Effect.sync(() => void renames++);
      harness.fileSystem.writeFileString = (path, value) =>
        writeFileString(path, value).pipe(
          Effect.andThen(Deferred.succeed(writeStarted, undefined)),
          Effect.andThen(Effect.never),
        );
      const writer = yield* modify({
        value: undefined,
        document: { enabled: true },
        afterCommit: Effect.sync(() => void afterCommits++),
      }).pipe(provideBuiltLayer(harness.layer), Effect.forkScoped);
      yield* Deferred.await(writeStarted);
      yield* Fiber.interrupt(writer);
      expect(harness.files.get("/config.json")).toBe('{"enabled":false}');
      expect([...harness.files.keys()]).toEqual(["/config.json"]);
      expect(renames).toBe(0);
      expect(afterCommits).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("commits the document and hook exactly once before honoring interruption", () =>
  Effect.gen(function* () {
    const renameStarted = yield* Deferred.make<void>();
    const releaseRename = yield* Deferred.make<void>();
    const harness = documentLayer({ "/config.json": '{"enabled":false}' });
    let afterCommits = 0;
    const rename = harness.fileSystem.rename;
    harness.fileSystem.rename = (from, to) =>
      Deferred.succeed(renameStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRename)),
        Effect.andThen(rename(from, to)),
      );
    const writer = yield* modify({
      value: undefined,
      document: { enabled: true },
      afterCommit: Effect.sync(() => void afterCommits++),
    }).pipe(provideBuiltLayer(harness.layer), Effect.forkScoped);
    yield* Deferred.await(renameStarted);
    const interruption = yield* Fiber.interrupt(writer).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(harness.files.get("/config.json")).toBe('{"enabled":false}');
    yield* Deferred.succeed(releaseRename, undefined);
    yield* Fiber.join(interruption);
    expect(harness.files.get("/config.json")).toContain('"enabled": true');
    expect([...harness.files.keys()]).toEqual(["/config.json"]);
    expect(afterCommits).toBe(1);
  }).pipe(Effect.scoped),
);
