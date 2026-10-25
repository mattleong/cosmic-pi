import { fileURLToPath } from "node:url";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { createJiti } from "jiti";
import { afterEach, vi } from "vitest";
import { extensionApiFixture } from "pi-cosmic-core/testing";

type Extension = typeof import("../src/extension.ts").default;

afterEach(() => vi.unstubAllEnvs());

it.effect.each([
  { marker: "1", succeeds: true },
  { marker: undefined, succeeds: false },
])("loads without the parent application only for child marker $marker", ({ marker, succeeds }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-subagents-entry-" });
    yield* fs.copy(fileURLToPath(new URL("../src", import.meta.url)), `${directory}/src`);
    yield* fs.remove(`${directory}/src/application`, { recursive: true });
    vi.stubEnv("PI_SUBAGENT_CHILD", marker);
    const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
    const result = yield* Effect.gen(function* () {
      const { default: extension } = yield* Effect.tryPromise(() =>
        jiti.import<{ default: Extension }>(`${directory}/src/extension.ts`),
      );
      yield* Effect.tryPromise(() => Promise.resolve(extension(extensionApiFixture({}))));
    }).pipe(Effect.exit);
    expect(Exit.isSuccess(result)).toBe(succeeds);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

// Pi loads extensions through jiti, whose module graph differs from the test runner's.
it.effect("registers the parent application when Pi's loader imports the entry", () =>
  Effect.gen(function* () {
    vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
    const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
    const result = yield* Effect.gen(function* () {
      const { default: extension } = yield* Effect.tryPromise(() =>
        jiti.import<{ default: Extension }>(fileURLToPath(new URL("../index.ts", import.meta.url))),
      );
      yield* Effect.tryPromise(() => Promise.resolve(extension(extensionApiFixture({}))));
    }).pipe(Effect.exit);
    expect(result).toStrictEqual(Exit.void);
  }),
);
