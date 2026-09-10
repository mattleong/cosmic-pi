import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { JsonDocumentStore, type JsonDocumentReadOptions } from "../src/platform/json-document.ts";
import { ProcessCoordinator } from "../src/platform/process-coordinator.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";

// Use Effect's real file-stream implementation over an owned short-read file fixture.
function documentLayer(initial: Record<string, string>, chunkBytes = 64 * 1024) {
  const files = new Map(Object.entries(initial));
  let readBytes = 0;
  let readers = 0;
  const fs = FileSystem.make(
    FileSystem.makeNoop({
      open: (path) =>
        Effect.gen(function* () {
          const source = files.get(path);
          if (source === undefined)
            return yield* Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "open",
              }),
            );
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
      readFile: (path) => Effect.sync(() => new TextEncoder().encode(files.get(path) ?? "")),
      chmod: () => Effect.void,
      makeDirectory: () => Effect.void,
      makeTempFile: () => Effect.succeed("/temporary/document.json"),
      writeFile: (path, bytes) =>
        Effect.sync(() => void files.set(path, new TextDecoder().decode(bytes))),
      rename: (from, to) =>
        Effect.sync(() => {
          files.set(to, files.get(from)!);
          files.delete(from);
        }),
    }),
  );
  return {
    files,
    get readBytes() {
      return readBytes;
    },
    get readers() {
      return readers;
    },
    layer: JsonDocumentStore.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(FileSystem.FileSystem, fs),
          Path.layer,
          ProcessCoordinator.layer,
        ),
      ),
    ),
  };
}

it.effect(
  "caps actual file bytes before parsing and never mutates or publishes an oversized read",
  () => {
    const source = "private-invalid-json".repeat(100);
    const fixture = documentLayer({ "/config.json": source });
    return Effect.gen(function* () {
      const store = yield* JsonDocumentStore;
      let mutated = false;
      let published = false;
      const options = { maxBytes: 32 };
      const modify = store.modifyObject!;
      const operations = [
        store.readObject("/config.json", options),
        modify(
          "/config.json",
          () => {
            mutated = true;
            return Effect.succeed({
              value: undefined,
              document: {},
              afterCommit: Effect.sync(() => {
                published = true;
              }),
            });
          },
          options,
        ),
        store.updateObject(
          "/config.json",
          () => {
            mutated = true;
            return {};
          },
          options,
        ),
      ];
      for (const operation of operations) {
        const before = fixture.readBytes;
        const error = yield* operation.pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "JsonDocumentError", operation: "read" });
        expect(String(error)).not.toContain("private-invalid-json");
        expect(fixture.readBytes - before).toBeLessThanOrEqual(options.maxBytes + 1);
        expect(fixture.readers).toBe(0);
      }
      expect(mutated).toBe(false);
      expect(published).toBe(false);
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
      expect(
        yield* store.updateObject("/missing.json", () => ({ created: true }), { maxBytes }),
      ).toEqual({ created: true });
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
      let published = false;
      const change = () =>
        Effect.succeed({
          value: replacement,
          document: replacement,
          afterCommit: Effect.sync(() => {
            published = true;
          }),
        });
      const failed = yield* store.modifyObject!("/config.json", change, {
        maxBytes: compactBytes,
      }).pipe(Effect.flip);
      expect(failed.operation).toBe("write");
      expect(published).toBe(false);
      expect(yield* store.readObject("/config.json")).toEqual(original);
      yield* store.modifyObject!("/config.json", change, { maxBytes: writtenBytes });
      expect(published).toBe(true);
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
        let mutated = false;
        expect(
          (yield* store
            .updateObject(
              "/missing.json",
              () => {
                mutated = true;
                return {};
              },
              options,
            )
            .pipe(Effect.flip)).operation,
        ).toBe("read");
        expect(mutated).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
}

it.effect(
  "in-memory locked reads reject oversized external changes before mutation and publication",
  () => {
    const memory = makeInMemoryDocuments({ "/config.json": { enabled: true } });
    let mutated = false;
    let published = false;
    memory.injectBeforeNextUpdate(() => ({ private: "secret".repeat(100) }));
    return Effect.gen(function* () {
      const error = yield* memory.service
        .modifyObject(
          "/config.json",
          () => {
            mutated = true;
            return Effect.succeed({
              value: undefined,
              document: {},
              afterCommit: Effect.sync(() => {
                published = true;
              }),
            });
          },
          { maxBytes: 64 },
        )
        .pipe(Effect.flip);
      expect(error.operation).toBe("read");
      expect(mutated).toBe(false);
      expect(published).toBe(false);
      expect(memory.documents.get("/config.json")).toEqual({ enabled: true });
    });
  },
);
