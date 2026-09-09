import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { runPilot } from "../../eval/pilot.ts";
import { runEpisode } from "../../eval/host-session.ts";
import { opaqueHostFixture } from "../support/host.ts";

const invalidExperiments: readonly unknown[] = [
  "adoption",
  "output",
  undefined,
  "private-unknown-experiment",
];

describe("historical pilot admission", () => {
  it.live("refuses unsupported pilot and episode calls before fixtures or inference", () =>
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
      let prompted = false;
      for (const experiment of invalidExperiments) {
        const options = experiment === undefined ? base : { ...base, experiment };
        yield* Effect.tryPromise(() =>
          expect(runPilot(opaqueHostFixture(options))).rejects.toMatchObject({
            _tag: "EvaluationError",
            operation: "preflight",
          }),
        );
        // Malformed JavaScript callers must be rejected even through the standalone SDK door.
        yield* Effect.tryPromise(() =>
          expect(
            runEpisode(opaqueHostFixture(options), () => {
              prompted = true;
              return Promise.resolve();
            }),
          ).rejects.toMatchObject({ _tag: "EvaluationError", operation: "preflight" }),
        );
      }
      expect(prompted).toBe(false);
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );

  it.live("refuses unsupported replay budgets before artifact or model setup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "code-mode-budget-test-" });
      for (const experiment of ["wording", "formatter"] as const) {
        for (const maxSessions of [0, 23, 25, 49, NaN, Infinity]) {
          yield* Effect.tryPromise(() =>
            expect(
              runPilot({
                scratch: root,
                agentDir: root,
                authDir: root,
                output: root,
                provider: "unavailable-test-provider",
                model: "unavailable-test-model",
                experiment,
                maxSessions,
              }),
            ).rejects.toMatchObject({ _tag: "EvaluationError", operation: "budget" }),
          );
        }
      }
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );
});
