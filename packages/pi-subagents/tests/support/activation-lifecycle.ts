// Activation-lifecycle scenarios shared by the root application and child bridge registration paths.
import { deferredPromise } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import * as subagentTools from "../../src/tools/subagent.ts";
import { effectTest, step } from "./effect-test.ts";

type LoadSettings = (cwd: string, projectTrusted: boolean, signal?: AbortSignal) => Promise<void>;

/** One registered Pi activation path, observed only through its host-facing effects. */
export interface ActivationPath {
  readonly start: () => PromiseLike<void>;
  readonly shutdown: () => PromiseLike<void>;
  readonly registeredToolCount: () => number;
  readonly activeTools: () => ReadonlyArray<string>;
}

export const describeActivationLifecycle = (
  label: string,
  makePath: (loadSettings?: LoadSettings) => ActivationPath,
) =>
  describe(`${label} activation lifecycle`, () => {
    effectTest("retires compact animation ownership on replacement and shutdown", function* () {
      const registration = vi.spyOn(subagentTools, "registerSubagentTools");
      const path = makePath();
      try {
        yield* step(path.start);
        const first = registration.mock.calls.at(-1)?.[1].scheduleAnimation;
        let oldTicks = 0;
        expect(first?.(1, () => oldTicks++)).toBeTypeOf("function");
        yield* step(() => vi.waitFor(() => expect(oldTicks).toBeGreaterThan(0)));
        yield* step(path.start);
        const retiredTicks = oldTicks;
        expect(first?.(1, () => oldTicks++)).toBeUndefined();
        const second = registration.mock.calls.at(-1)?.[1].scheduleAnimation;
        let newTicks = 0;
        expect(second?.(1, () => newTicks++)).toBeTypeOf("function");
        yield* step(() => vi.waitFor(() => expect(newTicks).toBeGreaterThan(0)));
        expect(oldTicks).toBe(retiredTicks);
        yield* step(path.shutdown);
        expect(second?.(1, () => newTicks++)).toBeUndefined();
      } finally {
        yield* step(path.shutdown);
        registration.mockRestore();
      }
    });

    effectTest("aborts preview loading on shutdown before tools can register", function* () {
      const preview = deferredPromise();
      let signal: AbortSignal | undefined;
      const path = makePath((_cwd, _trusted, owned) => {
        signal = owned;
        return preview.promise;
      });

      const starting = path.start();
      yield* step(() => vi.waitFor(() => expect(signal).toBeDefined()));
      yield* step(path.shutdown);
      expect(signal?.aborted).toBe(true);
      yield* step(() => starting);
      expect(path.registeredToolCount()).toBe(0);
      preview.resolve();
      yield* step(() => preview.promise);
      expect(path.registeredToolCount()).toBe(0);
      expect(path.activeTools()).toEqual(["read"]);
    });

    effectTest("activates after rejected preview loading", function* () {
      const path = makePath(() => Promise.reject(new Error("preview settings rejected")));
      yield* step(path.start);
      expect(path.activeTools()).toEqual(expect.arrayContaining(["read", "subagent_start"]));
      yield* step(path.shutdown);
    });
  });
