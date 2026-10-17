import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime, piHostLoggerLayer } from "../src/runtime/runtime.ts";
import { extensionApiFixture } from "../testing.ts";
import { silencedConsole } from "./support/spies.ts";

it.effect("keeps Effect log output off the TTY console", () =>
  Effect.gen(function* () {
    const consoleCalls = yield* silencedConsole;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => makePiManagedRuntime(extensionApiFixture({}), Layer.empty)),
      (managed) => Effect.promise(() => managed.dispose()),
    );
    yield* Effect.promise(() =>
      runtime.run(Effect.logWarning("Subscription usage recovery: refresh_failed.")),
    );
    yield* Effect.logWarning("standalone host logger must stay off the TTY").pipe(
      Effect.provide(piHostLoggerLayer),
    );
    expect(consoleCalls()).toBe(0);
  }),
);
