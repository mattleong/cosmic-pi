import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { JsonDocumentStore as RootDocumentStore } from "pi-cosmic-core";
import { JsonDocumentStore } from "pi-cosmic-core/platform/json-document";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { runBoundedProcessNode } from "pi-cosmic-core/platform/process";

it.live.each(["native", "jiti"])(
  "uses narrow source entrypoints without HTTP, RPC, or process runners (%s)",
  (loader) =>
    Effect.gen(function* () {
      const loaderArgs =
        loader === "jiti" ? ["--import", "jiti/register"] : ["--experimental-strip-types"];
      const result = yield* runBoundedProcessNode({
        executable: process.execPath,
        args: [...loaderArgs, "tests/fixtures/narrow-entrypoints.ts"],
        stdoutLimitBytes: 1_024,
        stderrLimitBytes: 8_192,
        timeoutMillis: 10_000,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("narrow-entrypoints-ok");
      expect(result.timedOut).toBe(false);
    }),
);

it.live("shares document service ownership between root and narrow consumers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cosmic-entrypoint-identity-" });
    const document = path.join(directory, "settings.json");
    const narrow = yield* JsonDocumentStore;
    const root = yield* RootDocumentStore;
    expect(root).toBe(narrow);
    yield* narrow.writeObject(document, { retained: true });
    yield* root.modifyObject(document, (current) =>
      Effect.succeed({ value: undefined, document: { ...current, updated: true } }),
    );
    expect(yield* narrow.readObject(document)).toEqual({ retained: true, updated: true });
  }).pipe(Effect.provide(nodeFilePlatformLayer)),
);
