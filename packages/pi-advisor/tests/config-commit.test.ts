// Effect test entry point owns the temporary Node filesystem fixture.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { advisorPlatformLayer } from "../src/boundary/executor.ts";
import type { ResolvedAdvisorConfig } from "../src/config/options.ts";
import { readRawAdvisorConfigEffect, writeAdvisorConfigPatchEffect } from "../src/config/store.ts";

it.effect("publishes committed config before interruption can observe the renamed document", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "pi-advisor-config-commit-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const path = join(directory, "advisor.json");
      const platform = yield* Layer.build(advisorPlatformLayer);
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      let published: ResolvedAdvisorConfig | undefined;
      let publications = 0;

      const writer = yield* writeAdvisorConfigPatchEffect({ enabled: false }, path, (next) =>
        Effect.sync(() => {
          publications += 1;
          published = next;
        }).pipe(
          Effect.andThen(Deferred.succeed(commitStarted, undefined)),
          Effect.andThen(Deferred.await(releaseCommit)),
        ),
      ).pipe(Effect.provide(platform), Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(commitStarted);
      expect(yield* readRawAdvisorConfigEffect(path).pipe(Effect.provide(platform))).toMatchObject({
        enabled: false,
      });
      expect(published?.enabled).toBe(false);

      const interruption = yield* Fiber.interrupt(writer).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      expect(interruption.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(interruption);
      expect(publications).toBe(1);
      expect(yield* readRawAdvisorConfigEffect(path).pipe(Effect.provide(platform))).toMatchObject({
        enabled: false,
      });
      expect(published?.enabled).toBe(false);
    }),
  ),
);
