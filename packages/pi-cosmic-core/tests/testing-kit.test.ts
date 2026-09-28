import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { nodeFsPromises as fs } from "../src/platform/node-builtins.ts";
import { deferredPromise, killChild, spawnIpcChild, temporaryDirectory } from "../testing.ts";

it.effect("settles a deferred promise once, with the exact value or error", () =>
  Effect.gen(function* () {
    const resolved = deferredPromise<string>();
    resolved.resolve("first");
    resolved.reject(new Error("ignored"));
    resolved.resolve("ignored");
    expect(yield* Effect.promise(() => resolved.promise)).toBe("first");

    const rejected = deferredPromise();
    const failure = new Error("rejected");
    rejected.reject(failure);
    rejected.resolve();
    const settled = yield* Effect.promise(() =>
      rejected.promise.then(
        () => undefined,
        (error: Error) => error,
      ),
    );
    expect(settled).toBe(failure);
  }),
);

it.live("records IPC messages from spawn and removes the temporary directory with its scope", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory("cosmic-kit-test-");
        const child = yield* spawnIpcChild(
          fileURLToPath(new URL("./fixtures/cross-process-lock-child.ts", import.meta.url)),
          [directory, "home"],
          { timeout: "10 seconds" },
        );
        yield* child.exited;
        // Both messages arrived before these waits began.
        yield* child.wait("attempting");
        yield* child.wait("finished");
        yield* killChild(child.child);
        return directory;
      }),
    );
    expect(
      yield* Effect.promise(() =>
        fs.stat(directory).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
  }),
);

it.live("explains a wait that times out with what the child sent and how it exited", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("cosmic-kit-test-");
      const child = yield* spawnIpcChild(
        fileURLToPath(new URL("./fixtures/cross-process-lock-child.ts", import.meta.url)),
        [directory, "home"],
        { timeout: "1 second" },
      );
      yield* child.exited;
      const exit = yield* Effect.exit(child.wait("never-sent"));
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : "";
      expect(message).toContain("never-sent");
      expect(message).toContain("finished");
      expect(message).toContain("Exit: 0");
    }),
  ),
);
