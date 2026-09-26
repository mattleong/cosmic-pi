import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonDocumentReadOptions,
  type JsonObject,
} from "../src/platform/json-document.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";
import { provideBuiltLayer } from "../index.ts";

/**
 * Owned in-memory FileSystem over Effect's real file-stream implementation with short reads.
 * Tests may reassign `fileSystem` members to inject faults; the store calls them through it.
 */
function documentLayer(initial: Readonly<Record<string, string>>, chunkBytes = 64 * 1024) {
  const files = new Map(Object.entries(initial));
  let readBytes = 0;
  let readers = 0;
  let sequence = 0;
  const fileSystem = {
    ...FileSystem.make(
      FileSystem.makeNoop({
        open: (path) =>
          Effect.gen(function* () {
            const source = files.get(path);
            if (source === undefined)
              return yield* PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "open",
              });
            const bytes = new TextEncoder().encode(source);
            let offset = 0;
            const file: FileSystem.File = {
              [FileSystem.FileTypeId]: FileSystem.FileTypeId,
              stat: Effect.die("bounded reads must not stat"),
              seek: () => Effect.succeed(FileSystem.Size(0)),
              sync: Effect.void,
              read: () => Effect.die("unexpected file read"),
              readAlloc: (size) =>
                Effect.sync(() => {
                  const chunk = bytes.slice(offset, offset + Math.min(Number(size), chunkBytes));
                  offset += chunk.length;
                  readBytes += chunk.length;
                  return chunk.length === 0 ? Option.none() : Option.some(chunk);
                }),
              truncate: () => Effect.die("unexpected truncate"),
              write: () => Effect.die("unexpected file write"),
              writeAll: () => Effect.die("unexpected file write"),
            };
            return yield* Effect.acquireRelease(
              Effect.sync(() => {
                readers++;
                return file;
              }),
              () =>
                Effect.sync(() => {
                  readers--;
                }),
            );
          }),
        // Yielding lets unlocked read-modify-write transactions interleave.
        readFile: (path) =>
          Effect.yieldNow.pipe(
            Effect.andThen(Effect.sync(() => new TextEncoder().encode(files.get(path) ?? ""))),
          ),
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
    get readBytes() {
      return readBytes;
    },
    get readers() {
      return readers;
    },
    layer: JsonDocumentStore.layer.pipe(
      Layer.provide(Layer.merge(Layer.succeed(FileSystem.FileSystem, fileSystem), Path.layer)),
    ),
  };
}

const modify = <A>(modification: JsonDocumentModification<A>) =>
  JsonDocumentStore.use((store) =>
    store.modifyObject("/config.json", () => Effect.succeed(modification)),
  );

/** A replacement that records whether it ran and whether its commit was published. */
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

it.effect("supports locked read-only modifications without rewriting documents", () => {
  const harness = documentLayer({ "/config.json": '{"known":true}' });
  return Effect.gen(function* () {
    let afterCommits = 0;
    const existingResult = yield* modify({
      value: "unchanged",
      document: { known: false },
      write: false,
      afterCommit: Effect.sync(() => void afterCommits++),
    });
    expect(existingResult).toBe("unchanged");
    expect(harness.files.get("/config.json")).toBe('{"known":true}');
    expect(afterCommits).toBe(0);
  }).pipe(provideBuiltLayer(harness.layer));
});

it.effect("serializes read-modify-write updates across independently provided Layers", () => {
  const harness = documentLayer({ "/auth.json": '{"alpha":1}' });
  const update = (field: string, value: number) =>
    JsonDocumentStore.use((store) =>
      store.modifyObject("/auth.json", (document) =>
        Effect.succeed({ value: undefined, document: { ...document, [field]: value } }),
      ),
    ).pipe(provideBuiltLayer(harness.layer));
  return Effect.gen(function* () {
    yield* Effect.all([update("beta", 2), update("gamma", 3)], {
      concurrency: "unbounded",
    });
    expect(
      yield* JsonDocumentStore.use((store) => store.readObject("/auth.json")).pipe(
        provideBuiltLayer(harness.layer),
      ),
    ).toEqual({
      alpha: 1,
      beta: 2,
      gamma: 3,
    });
  });
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
    const invalidDocument = {
      dropped: undefined,
      coerced: Number.NaN,
    };
    // SAFETY: This deliberately invalid fixture exercises the store's runtime JSON validation.
    const invalidJsonDocument = invalidDocument as typeof invalidDocument &
      Schema.MutableJsonObject;
    const result = yield* Effect.result(store.writeObject("/config.json", invalidJsonDocument));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("encode");
    expect(harness.files.has("/config.json")).toBe(false);
  }).pipe(provideBuiltLayer(harness.layer));
});

it.effect("does not clean up a temporary path when exclusive acquisition fails", () => {
  const harness = documentLayer({});
  let removals = 0;
  harness.fileSystem.makeTempFile = () =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "makeTempFile",
      }),
    );
  harness.fileSystem.remove = () => Effect.sync(() => void removals++);
  return Effect.gen(function* () {
    const store = yield* JsonDocumentStore;
    const result = yield* Effect.result(store.writeObject("/config.json", { enabled: true }));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("write");
    expect(removals).toBe(0);
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

it.effect("does not run an after-commit hook when temporary writing fails", () => {
  const harness = documentLayer({ "/config.json": '{"enabled":false}' });
  let afterCommits = 0;
  let renames = 0;
  harness.fileSystem.rename = () => Effect.sync(() => void renames++);
  harness.fileSystem.writeFileString = () =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "BadResource",
        module: "FileSystem",
        method: "writeFileString",
      }),
    );
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      modify({
        value: undefined,
        document: { enabled: true },
        afterCommit: Effect.sync(() => void afterCommits++),
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("write");
    expect(harness.files.get("/config.json")).toBe('{"enabled":false}');
    expect(renames).toBe(0);
    expect(afterCommits).toBe(0);
  }).pipe(provideBuiltLayer(harness.layer));
});

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

it.effect("treats rename as the final fallible commit and ignores cleanup defects", () => {
  const harness = documentLayer({});
  const chmodPaths: string[] = [];
  let cleanupAttempts = 0;
  harness.fileSystem.chmod = (path) => Effect.sync(() => void chmodPaths.push(String(path)));
  harness.fileSystem.remove = () =>
    Effect.sync(() => void cleanupAttempts++).pipe(
      Effect.andThen(Effect.die("expected cleanup defect")),
    );
  return Effect.gen(function* () {
    const result = yield* Effect.exit(
      JsonDocumentStore.use((store) => store.writeObject("/config.json", { enabled: true })),
    );
    expect(result._tag).toBe("Success");
    expect(harness.files.get("/config.json")).toContain('"enabled": true');
    expect(chmodPaths).toEqual(["/tmp/document-0/value.json"]);
    expect(cleanupAttempts).toBe(1);
  }).pipe(provideBuiltLayer(harness.layer));
});

it.effect("preserves a rename failure when best-effort cleanup also defects", () => {
  const harness = documentLayer({ "/config.json": "old" });
  let cleanupAttempts = 0;
  harness.fileSystem.remove = () =>
    Effect.sync(() => void cleanupAttempts++).pipe(
      Effect.andThen(Effect.die("expected cleanup defect")),
    );
  harness.fileSystem.rename = () =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "AlreadyExists",
        module: "FileSystem",
        method: "rename",
      }),
    );
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      JsonDocumentStore.use((store) => store.writeObject("/config.json", { enabled: true })),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("rename");
    expect(harness.files.get("/config.json")).toBe("old");
    expect(cleanupAttempts).toBe(1);
  }).pipe(provideBuiltLayer(harness.layer));
});

it.effect(
  "caps actual file bytes before parsing and never mutates or publishes an oversized read",
  () => {
    const source = "private-invalid-json".repeat(100);
    const fixture = documentLayer({ "/config.json": source });
    return Effect.gen(function* () {
      const store = yield* JsonDocumentStore;
      const { state, change } = trackedModification({});
      const options = { maxBytes: 32 };
      const operations = [
        store.readObject("/config.json", options),
        store.modifyObject("/config.json", change, options),
      ];
      for (const operation of operations) {
        const before = fixture.readBytes;
        const error = yield* operation.pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "JsonDocumentError", operation: "read" });
        expect(String(error)).not.toContain("private-invalid-json");
        expect(fixture.readBytes - before).toBeLessThanOrEqual(options.maxBytes + 1);
        expect(fixture.readers).toBe(0);
      }
      expect(state).toEqual({ mutated: false, published: false });
      expect(fixture.files.get("/config.json")).toBe(source);
    }).pipe(Effect.provide(fixture.layer));
  },
);

for (const kind of ["filesystem", "memory"] as const) {
  it.effect(`accepts the exact UTF-8 boundary and rejects one byte less in ${kind}`, () => {
    const document = { text: "é😀" };
    const source = `${JSON.stringify(document, null, 2)}\n`;
    const maxBytes = new TextEncoder().encode(source).byteLength;
    const layer =
      kind === "filesystem"
        ? documentLayer({ "/config.json": source }, 3).layer
        : makeInMemoryDocuments({ "/config.json": document }).layer;
    return Effect.gen(function* () {
      const store = yield* JsonDocumentStore;
      expect(yield* store.readObject("/config.json", { maxBytes })).toEqual(document);
      expect(
        (yield* store.readObject("/config.json", { maxBytes: maxBytes - 1 }).pipe(Effect.flip))
          .operation,
      ).toBe("read");
      expect(yield* store.readObject("/config.json")).toEqual(document);
      expect(yield* store.readObject("/missing.json", { maxBytes })).toBeUndefined();
      yield* store.modifyObject(
        "/missing.json",
        () => Effect.succeed({ value: undefined, document: { created: true } }),
        { maxBytes },
      );
      expect(yield* store.readObject("/missing.json")).toEqual({ created: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect(`bounds serialized replacements before committing in ${kind}`, () => {
    const original = {};
    const replacement = { text: "é😀" };
    const compactBytes = new TextEncoder().encode(JSON.stringify(replacement)).byteLength;
    const writtenBytes = new TextEncoder().encode(
      `${JSON.stringify(replacement, null, 2)}\n`,
    ).byteLength;
    const layer =
      kind === "filesystem"
        ? documentLayer({ "/config.json": "{}\n" }).layer
        : makeInMemoryDocuments({ "/config.json": original }).layer;
    return Effect.gen(function* () {
      const store = yield* JsonDocumentStore;
      const { state, change } = trackedModification(replacement);
      const failed = yield* store
        .modifyObject("/config.json", change, {
          maxBytes: compactBytes,
        })
        .pipe(Effect.flip);
      expect(failed.operation).toBe("write");
      expect(state.published).toBe(false);
      expect(yield* store.readObject("/config.json")).toEqual(original);
      yield* store.modifyObject("/config.json", change, { maxBytes: writtenBytes });
      expect(state.published).toBe(true);
      expect(yield* store.readObject("/config.json", { maxBytes: writtenBytes })).toEqual(
        replacement,
      );
    }).pipe(Effect.provide(layer));
  });

  const invalidOptions: JsonDocumentReadOptions[] = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    64 * 1024 * 1024 + 1,
  ].map((maxBytes) => ({ maxBytes }));
  it.effect.each(invalidOptions)(
    `rejects invalid read limits before reading or mutating missing ${kind} documents: %j`,
    (options) => {
      const layer = kind === "filesystem" ? documentLayer({}).layer : makeInMemoryDocuments().layer;
      return Effect.gen(function* () {
        const store = yield* JsonDocumentStore;
        expect(
          (yield* store.readObject("/missing.json", options).pipe(Effect.flip)).operation,
        ).toBe("read");
        const { state, change } = trackedModification({});
        expect(
          (yield* store.modifyObject("/missing.json", change, options).pipe(Effect.flip)).operation,
        ).toBe("read");
        expect(state.mutated).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
}

it.effect(
  "in-memory locked reads reject oversized external changes before mutation and publication",
  () => {
    const memory = makeInMemoryDocuments({ "/config.json": { enabled: true } });
    const { state, change } = trackedModification({});
    memory.injectBeforeNextUpdate(() => ({ private: "secret".repeat(100) }));
    return Effect.gen(function* () {
      const error = yield* memory.service
        .modifyObject("/config.json", change, { maxBytes: 64 })
        .pipe(Effect.flip);
      expect(error.operation).toBe("read");
      expect(state).toEqual({ mutated: false, published: false });
      expect(memory.documents.get("/config.json")).toEqual({ enabled: true });
    });
  },
);
