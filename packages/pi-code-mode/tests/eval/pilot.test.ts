import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { runPilot } from "../../eval/pilot.ts";

describe("historical pilot admission", () => {
  it.live("refuses archived and implicit experiments before artifacts or inference", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "code-mode-archive-test-" });
      const base = {
        scratch: root,
        agentDir: path.join(root, "agent"),
        authDir: path.join(root, "absent-auth"),
        output: path.join(root, "absent-output"),
        provider: "unavailable-test-provider",
        model: "unavailable-test-model",
        maxSessions: 24,
      };
      for (const experiment of ["adoption", "output", undefined] as const) {
        const options = experiment === undefined ? base : { ...base, experiment };
        yield* Effect.tryPromise(() =>
          expect(runPilot(options)).rejects.toMatchObject({
            _tag: "EvaluationError",
            operation: "preflight",
            message: expect.stringContaining("Model-backed replay is disabled"),
          }),
        );
      }
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );
});
