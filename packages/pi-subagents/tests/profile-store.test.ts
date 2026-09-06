// Real temporary files exercise the store's optimistic persistence boundary.
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer, provideBuiltLayer } from "pi-cosmic-core";
import { afterEach, describe, expect } from "vitest";
import {
  SubagentConfigStore,
  subagentConfigStoreLayer,
  type SubagentConfigStoreContract,
} from "../src/config/store.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

const { mkdtemp, readFile, rm, writeFile } = nodeFsPromises;
const { join } = nodePath;
const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))).then(
    () => undefined,
  ),
);
const layer = subagentConfigStoreLayer.pipe(Layer.provide(nodeFilePlatformLayer));
const withStore = <A, E>(f: (store: SubagentConfigStoreContract) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(SubagentConfigStore, f).pipe(provideBuiltLayer(layer)));
const fixture = () =>
  mkdtemp(join(tmpdir(), "pi-workspace-config-")).then((root) => {
    roots.push(root);
    return { root, path: join(root, "pi-subagents.json") };
  });

describe("writer workspace preference persistence", () => {
  effectTest(
    "saves and clears a preference without changing profile sets or nesting",
    function* () {
      const { root, path } = yield* step(fixture);
      const original = {
        version: 6,
        profileSets: { saved: { profiles: {} } },
        defaultProfileSet: "saved",
        nesting: { maxDirectChildren: 4, maxDepth: 2 },
      };
      yield* step(() => writeFile(path, JSON.stringify(original)));
      yield* step(() =>
        withStore((store) =>
          store.patchWriterWorkspace(root, root, {
            scope: "global",
            projectTrusted: false,
            expectedExists: true,
            expectedDocument: original,
            writerWorkspaceMode: "shared-checkout",
          }),
        ),
      );
      const saved = { ...original, writerWorkspaceMode: "shared-checkout" };
      expect(JSON.parse(yield* step(() => readFile(path, "utf8")))).toEqual(saved);
      expect(
        (yield* step(() => withStore((store) => store.load(root, root, false))))
          .writerWorkspaceMode,
      ).toBe("shared-checkout");
      yield* step(() =>
        withStore((store) =>
          store.patchWriterWorkspace(root, root, {
            scope: "global",
            projectTrusted: false,
            expectedExists: true,
            expectedDocument: saved,
          }),
        ),
      );
      expect(JSON.parse(yield* step(() => readFile(path, "utf8")))).toEqual(original);
      expect(
        (yield* step(() => withStore((store) => store.load(root, root, false))))
          .writerWorkspaceMode,
      ).toBe("shared-checkout");
    },
  );

  effectTest("rejects stale preference saves without overwriting another edit", function* () {
    const { root, path } = yield* step(fixture);
    const current = { version: 6, writerWorkspaceMode: "worktree" };
    yield* step(() => writeFile(path, JSON.stringify(current)));
    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchWriterWorkspace(root, root, {
            scope: "global",
            projectTrusted: false,
            expectedExists: true,
            expectedDocument: { version: 6 },
            writerWorkspaceMode: "shared-checkout",
          }),
        ),
      ).rejects.toMatchObject({ operation: "update" }),
    );
    expect(JSON.parse(yield* step(() => readFile(path, "utf8")))).toEqual(current);
  });

  effectTest("rejects malformed persisted preferences at activation", function* () {
    const { root, path } = yield* step(fixture);
    yield* step(() =>
      writeFile(path, JSON.stringify({ version: 6, writerWorkspaceMode: "invalid" })),
    );
    yield* step(() =>
      expect(withStore((store) => store.load(root, root, false))).rejects.toMatchObject({
        operation: "activate",
      }),
    );
  });

  effectTest("migrates valid legacy documents when saving a workspace preference", function* () {
    const { root, path } = yield* step(fixture);
    const original = { version: 5, nesting: { maxDirectChildren: 4, maxDepth: 2 } };
    yield* step(() => writeFile(path, JSON.stringify(original)));
    yield* step(() =>
      withStore((store) =>
        store.patchWriterWorkspace(root, root, {
          scope: "global",
          projectTrusted: false,
          expectedExists: true,
          expectedDocument: original,
          writerWorkspaceMode: "shared-checkout",
        }),
      ),
    );
    expect(JSON.parse(yield* step(() => readFile(path, "utf8")))).toEqual({
      ...original,
      version: 6,
      writerWorkspaceMode: "shared-checkout",
    });
  });
});
