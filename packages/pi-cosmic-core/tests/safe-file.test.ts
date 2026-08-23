// Security adapter coverage intentionally uses real Node filesystem primitives.
import { tmpdir } from "node:os";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { provideBuiltLayer, SafeFile } from "../index.ts";
import { nodeFsPromises, nodePath } from "../src/platform/node-builtins.ts";
import { closeSafeFileHandle } from "../src/platform/safe-file.ts";
import { capturedTelemetrySnapshot, makeCapturedTracer } from "../testing.ts";

const { mkdir, mkdtemp, realpath, rm, symlink, writeFile } = nodeFsPromises;
const { join } = nodePath;

class TestFileSystemError extends Schema.TaggedError<TestFileSystemError>()("TestFileSystemError", {
  operation: Schema.String,
}) {}

const testFileSystem = <A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, TestFileSystemError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new TestFileSystemError({ operation }),
  });

const withDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | TestFileSystemError, R> =>
  Effect.acquireUseRelease(
    testFileSystem("make temp directory", () => mkdtemp(join(tmpdir(), "cosmic-safe-file-"))),
    use,
    (directory) =>
      testFileSystem("remove temp directory", () =>
        rm(directory, { recursive: true, force: true }),
      ),
  );

it.live("reads a stable file and captures a path-free resource span", () => {
  const captured = makeCapturedTracer();
  return withDirectory((directory) =>
    Effect.gen(function* () {
      const root = yield* testFileSystem("resolve temp directory", () => realpath(directory));
      const file = join(root, "input.txt");
      yield* testFileSystem("write fixture", () => writeFile(file, "safe"));
      const safeFile = yield* SafeFile;
      const result = yield* safeFile.readContainedRegularFile(file, root, 32);
      expect(new TextDecoder().decode(result.bytes)).toBe("safe");
      expect(result.path).toBe(file);
      expect(captured.spans.map((span) => span.name)).toContain(
        "pi-cosmic-core.safe-file.initialize",
      );
      expect(capturedTelemetrySnapshot(captured)).not.toContain(file);
    }),
  ).pipe(
    provideBuiltLayer(
      SafeFile.layer.pipe(Layer.provide(NodePath.layer), Layer.provide(captured.layer)),
    ),
  );
});

it.live("fails safely when the file exceeds the configured limit", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const root = yield* testFileSystem("resolve temp directory", () => realpath(directory));
      const file = join(root, "large.txt");
      yield* testFileSystem("write fixture", () => writeFile(file, "too large"));
      const safeFile = yield* SafeFile;
      const result = yield* Effect.result(safeFile.readContainedRegularFile(file, root, 2));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(String(result.failure)).not.toContain(file);
    }),
  ).pipe(provideBuiltLayer(SafeFile.layer.pipe(Layer.provide(NodePath.layer)))),
);

it.live("rejects symlinked roots, leaf symlinks, and files outside the containment root", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const root = yield* testFileSystem("resolve temp directory", () => realpath(directory));
      const workspace = join(root, "workspace");
      const outside = join(root, "outside.txt");
      const file = join(workspace, "input.txt");
      const leafLink = join(workspace, "leaf-link.txt");
      const rootLink = join(root, "workspace-link");
      yield* testFileSystem("create workspace", () => mkdir(workspace));
      yield* testFileSystem("write contained fixture", () => writeFile(file, "safe"));
      yield* testFileSystem("write outside fixture", () => writeFile(outside, "outside"));
      yield* testFileSystem("create leaf symlink", () => symlink(file, leafLink));
      yield* testFileSystem("create root symlink", () => symlink(workspace, rootLink, "dir"));
      const safeFile = yield* SafeFile;

      for (const attempt of [
        safeFile.readContainedRegularFile(leafLink, workspace, 32),
        safeFile.readContainedRegularFile(outside, workspace, 32),
        safeFile.readContainedRegularFile(file, rootLink, 32),
      ]) {
        const result = yield* Effect.result(attempt);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(String(result.failure)).not.toContain(root);
        }
      }
    }),
  ).pipe(provideBuiltLayer(SafeFile.layer.pipe(Layer.provide(NodePath.layer)))),
);

it.effect("maps close rejection to a redacted typed failure before deliberate recovery", () =>
  Effect.gen(function* () {
    const close = () => Promise.reject(new Error("secret close failure"));
    const result = yield* Effect.result(closeSafeFileHandle({ close }));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.operation).toBe("close");
      expect(String(result.failure)).not.toContain("secret close failure");
    }
    const recovered = yield* Effect.exit(
      closeSafeFileHandle({ close }).pipe(Effect.catch(() => Effect.void)),
    );
    expect(recovered._tag).toBe("Success");
  }),
);
