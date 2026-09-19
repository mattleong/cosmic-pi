// Exercise the real source-only entrypoint without starting application resources.
import { fileURLToPath } from "node:url";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { createJiti } from "jiti";
import { afterEach, vi } from "vitest";
import { extensionApiFixture } from "./fixtures/pi-host.ts";

type Extension = typeof import("../src/extension.ts").default;

afterEach(() => vi.unstubAllEnvs());

it.effect.each([
  { marker: "1", succeeds: true },
  { marker: undefined, succeeds: false },
])("loads without the parent application only for child marker $marker", ({ marker, succeeds }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-subagents-entry-" });
    // A partial installed package proves the child does not evaluate parent-only imports.
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

it.effect.each([undefined, "0", "true"])(
  "finishes root registration before resolving for marker %s on repeated loads",
  (marker) =>
    Effect.gen(function* () {
      vi.stubEnv("PI_SUBAGENT_CHILD", marker);
      for (let reload = 0; reload < 2; reload++) {
        vi.resetModules();
        const { default: extension } = yield* Effect.tryPromise(
          () => import("../src/extension.ts"),
        );
        const pi = extensionApiFixture({
          on: vi.fn(),
          registerCommand: vi.fn(),
          registerMessageRenderer: vi.fn(),
        });
        yield* Effect.tryPromise(() => Promise.resolve(extension(pi)));
        expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
        expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
        expect(pi.registerCommand).toHaveBeenCalledWith(
          "subagents",
          expect.objectContaining({ handler: expect.any(Function) }),
        );
      }
    }),
);
