import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import { JsonDocumentStore } from "../src/platform/json-document.ts";
import { ProcessCoordinator } from "../src/platform/process-coordinator.ts";
import { provideBuiltLayer } from "../index.ts";

function documentLayer(initial: Readonly<Record<string, string>>) {
  const files = new Map(Object.entries(initial));
  let sequence = 0;
  const fileSystem = {
    ...FileSystem.makeNoop({
      chmod: () => Effect.void,
      exists: (path) => Effect.succeed(files.has(String(path))),
      makeDirectory: () => Effect.void,
      makeTempFile: () =>
        Effect.sync(() => {
          const path = `/tmp/document-${sequence++}/value.json`;
          files.set(path, "");
          return path;
        }),
      readFileString: (path) =>
        Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => files.get(String(path)) ?? ""))),
      remove: (path) =>
        Effect.sync(() => {
          const owned = String(path);
          for (const candidate of files.keys()) {
            if (candidate === owned || candidate.startsWith(`${owned}/`)) files.delete(candidate);
          }
        }),
      rename: (from, to) =>
        Effect.sync(() => {
          const value = files.get(String(from));
          if (value !== undefined) files.set(String(to), value);
          files.delete(String(from));
        }),
      writeFileString: (path, value) => Effect.sync(() => void files.set(String(path), value)),
    }),
  };
  return {
    files,
    fileSystem,
    layer: JsonDocumentStore.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem, fileSystem),
          Path.layer,
          ProcessCoordinator.layer,
        ),
      ),
    ),
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
  }).pipe(provideBuiltLayer(harness.layer));
});

it.effect("supports locked read-only modifications without rewriting documents", () => {
  const harness = documentLayer({ "/config.json": '{"known":true}' });
  return Effect.gen(function* () {
    let afterCommits = 0;
    const existingResult = yield* JsonDocumentStore.use((store) => {
      const modifyObject = store.modifyObject;
      return modifyObject === undefined
        ? Effect.die("atomic document modification unavailable")
        : modifyObject("/config.json", () =>
            Effect.succeed({
              value: "unchanged",
              document: { known: false },
              write: false,
              afterCommit: Effect.sync(() => void afterCommits++),
            }),
          );
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
      store.updateObject("/auth.json", (document) => ({ ...document, [field]: value })),
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
    const store = yield* JsonDocumentStore;
    const result = yield* Effect.result(
      store.updateObject("/auth.json", (document) => ({ ...document, xai: {} })),
    );
    expect(result._tag).toBe("Failure");
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
      const writer = yield* JsonDocumentStore.use((store) => {
        const modifyObject = store.modifyObject;
        return modifyObject === undefined
          ? Effect.die("atomic document modification unavailable")
          : modifyObject("/config.json", () =>
              Effect.succeed({
                value: undefined,
                document: { enabled: true },
                afterCommit: Effect.sync(() => void afterCommits++),
              }),
            );
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
      JsonDocumentStore.use((store) => {
        const modifyObject = store.modifyObject;
        return modifyObject === undefined
          ? Effect.die("atomic document modification unavailable")
          : modifyObject("/config.json", () =>
              Effect.succeed({
                value: undefined,
                document: { enabled: true },
                afterCommit: Effect.sync(() => void afterCommits++),
              }),
            );
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
    const writer = yield* JsonDocumentStore.use((store) => {
      const modifyObject = store.modifyObject;
      return modifyObject === undefined
        ? Effect.die("atomic document modification unavailable")
        : modifyObject("/config.json", () =>
            Effect.succeed({
              value: undefined,
              document: { enabled: true },
              afterCommit: Effect.sync(() => void afterCommits++),
            }),
          );
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
