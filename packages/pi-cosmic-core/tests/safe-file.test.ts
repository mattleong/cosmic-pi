// Security adapter coverage intentionally uses real Node filesystem primitives.
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { provideBuiltLayer, SafeFile } from "../index.ts";
import { nodeFsPromises, nodePath } from "../src/platform/node-builtins.ts";
import { capturedTelemetrySnapshot, makeCapturedTracer, temporaryDirectory } from "../testing.ts";

const { mkdir, realpath, symlink, writeFile } = nodeFsPromises;
const { join } = nodePath;
const fixtureRoot = temporaryDirectory("cosmic-safe-file-").pipe(
  Effect.flatMap((directory) => Effect.promise(() => realpath(directory))),
);

it.live("reads a stable file and captures a path-free resource span", () => {
  const captured = makeCapturedTracer();
  return Effect.gen(function* () {
    const root = yield* fixtureRoot;
    const file = join(root, "input.txt");
    yield* Effect.promise(() => writeFile(file, "safe"));
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

it.live("fails safely when the file exceeds the configured limit", () =>
  Effect.gen(function* () {
    const root = yield* fixtureRoot;
    const file = join(root, "large.txt");
    yield* Effect.promise(() => writeFile(file, "too large"));
    const safeFile = yield* SafeFile;
    const result = yield* Effect.result(safeFile.readContainedRegularFile(file, root, 2));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(String(result.failure)).not.toContain(file);
  }).pipe(provideBuiltLayer(SafeFile.layer.pipe(Layer.provide(NodePath.layer)))),
);

it.live("rejects symlinked roots, leaf symlinks, and files outside the containment root", () =>
  Effect.gen(function* () {
    const root = yield* fixtureRoot;
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    const file = join(workspace, "input.txt");
    const leafLink = join(workspace, "leaf-link.txt");
    const rootLink = join(root, "workspace-link");
    yield* Effect.promise(() => mkdir(workspace));
    yield* Effect.promise(() => writeFile(file, "safe"));
    yield* Effect.promise(() => writeFile(outside, "outside"));
    yield* Effect.promise(() => symlink(file, leafLink));
    yield* Effect.promise(() => symlink(workspace, rootLink, "dir"));
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
  }).pipe(provideBuiltLayer(SafeFile.layer.pipe(Layer.provide(NodePath.layer)))),
);
