import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { vi } from "vitest";
import { provideBuiltLayer, SafeFile } from "../index.ts";
import { nodeFsPromises, nodePath } from "../src/platform/node-builtins.ts";
import {
  capturedTelemetrySnapshot,
  deferredPromise,
  makeCapturedTracer,
  temporaryDirectory,
} from "../testing.ts";

const fs = nodeFsPromises;
const fixtureRoot = temporaryDirectory("cosmic-safe-file-").pipe(
  Effect.flatMap((directory) => Effect.promise(() => fs.realpath(directory))),
);

const openedFile = (content = "safe") =>
  Effect.gen(function* () {
    const root = yield* fixtureRoot;
    const file = nodePath.join(root, "input.txt");
    yield* Effect.promise(() => fs.writeFile(file, content));
    const handle = yield* Effect.acquireRelease(
      Effect.promise(() => nodeFsPromises.open(file, "r")),
      (opened) => Effect.promise(() => opened.close()),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(nodeFsPromises, "open").mockResolvedValue(handle)),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    return { root, file, handle };
  });

for (const change of ["growth", "read failure"])
  it.live(`bounds reads and closes the handle on ${change} after inspection`, () =>
    Effect.gen(function* () {
      const { root, file, handle } = yield* openedFile();
      const read = handle.read.bind(handle);
      let largestBuffer = 0;
      let transferred = 0;
      let firstRead = true;
      vi.spyOn(handle, "read").mockImplementation((options) =>
        Promise.resolve()
          .then(() => {
            largestBuffer = Math.max(largestBuffer, options?.buffer?.byteLength ?? 0);
            if (!firstRead) return undefined;
            firstRead = false;
            if (change === "read failure") throw new Error(`Sensitive failure: ${file}`);
            if (change === "growth") return fs.writeFile(file, "safe but now oversized");
            return undefined;
          })
          .then(() => read(options))
          .then((result) => {
            transferred += result.bytesRead;
            return result;
          }),
      );
      const safeFile = yield* SafeFile;
      const result = yield* Effect.result(safeFile.readContainedRegularFile(file, root, 4));
      expect(result._tag).toBe("Failure");
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("SafeFileError");
        expect(String(result.failure)).not.toContain(root);
      }
      expect(largestBuffer).toBe(4);
      expect(transferred).toBeLessThanOrEqual(5);
      expect(handle.fd).toBe(-1);
    }).pipe(provideBuiltLayer(SafeFile.layer.pipe(Layer.provide(NodePath.layer)))),
  );

it.live(
  "rejects a same-size overwrite between partial reads instead of returning mixed content",
  () =>
    Effect.gen(function* () {
      const { root, file, handle } = yield* openedFile();
      const read = handle.read.bind(handle);
      let firstRead = true;
      vi.spyOn(handle, "read").mockImplementation((options) =>
        read({ ...options, length: Math.min(options?.length ?? 1, 2) }).then((result) => {
          if (!firstRead) return result;
          firstRead = false;
          return fs
            .writeFile(file, "evil")
            .then(() => fs.utimes(file, 1, 1))
            .then(() => result);
        }),
      );
      const safeFile = yield* SafeFile;
      const result = yield* Effect.result(safeFile.readContainedRegularFile(file, root, 4));
      expect(result._tag).toBe("Failure");
      expect(handle.fd).toBe(-1);
    }).pipe(provideBuiltLayer(SafeFile.layer.pipe(Layer.provide(NodePath.layer)))),
);

it.live("closes the handle when an in-flight read is interrupted", () =>
  Effect.gen(function* () {
    const { root, file, handle } = yield* openedFile();
    const started = deferredPromise();
    const pending = deferredPromise<Awaited<ReturnType<typeof handle.read>>>();
    vi.spyOn(handle, "read").mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const safeFile = yield* SafeFile;
    const fiber = yield* safeFile.readContainedRegularFile(file, root, 4).pipe(Effect.forkChild());
    yield* Effect.promise(() => started.promise);
    yield* Fiber.interrupt(fiber);
    expect(handle.fd).toBe(-1);
    pending.resolve({ bytesRead: 0, buffer: new Uint8Array(0) });
  }).pipe(provideBuiltLayer(SafeFile.layer.pipe(Layer.provide(NodePath.layer)))),
);

it.live("reads a stable file and captures a path-free resource span", () => {
  const captured = makeCapturedTracer();
  return Effect.gen(function* () {
    const root = yield* fixtureRoot;
    const file = nodePath.join(root, "input.txt");
    yield* Effect.promise(() => fs.writeFile(file, "safe"));
    const safeFile = yield* SafeFile;
    const result = yield* safeFile.readContainedRegularFile(file, root, 32);
    expect(new TextDecoder().decode(result.bytes)).toBe("safe");
    expect(result.path).toBe(file);
    expect(captured.spans.map((span) => span.name)).toContain(
      "pi-cosmic-core.safe-file.initialize",
    );
    expect(capturedTelemetrySnapshot(captured)).not.toContain(file);
  }).pipe(
    provideBuiltLayer(
      SafeFile.layer.pipe(Layer.provide(NodePath.layer), Layer.provide(captured.layer)),
    ),
  );
});

it.live("rejects symlinked roots, leaf symlinks, and files outside the containment root", () =>
  Effect.gen(function* () {
    const root = yield* fixtureRoot;
    const workspace = nodePath.join(root, "workspace");
    const outside = nodePath.join(root, "outside.txt");
    const file = nodePath.join(workspace, "input.txt");
    const leafLink = nodePath.join(workspace, "leaf-link.txt");
    const rootLink = nodePath.join(root, "workspace-link");
    yield* Effect.promise(() => fs.mkdir(workspace));
    yield* Effect.promise(() => fs.writeFile(file, "safe"));
    yield* Effect.promise(() => fs.writeFile(outside, "outside"));
    yield* Effect.promise(() => fs.symlink(file, leafLink));
    yield* Effect.promise(() => fs.symlink(workspace, rootLink, "dir"));
    const safeFile = yield* SafeFile;

    for (const attempt of [
      safeFile.readContainedRegularFile(leafLink, workspace, 32),
      safeFile.readContainedRegularFile(outside, workspace, 32),
      safeFile.readContainedRegularFile(file, rootLink, 32),
    ]) {
      const result = yield* Effect.result(attempt);
      expect(result._tag).toBe("Failure");
      if (Result.isFailure(result)) {
        expect(String(result.failure)).not.toContain(root);
      }
    }
  }).pipe(provideBuiltLayer(SafeFile.layer.pipe(Layer.provide(NodePath.layer)))),
);
