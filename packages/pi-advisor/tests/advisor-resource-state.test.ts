import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { makeAdvisorResourceState } from "../src/advisor-resource-state.ts";

class AcquireFailure extends Schema.TaggedErrorClass<AcquireFailure>()("AcquireFailure", {
  message: Schema.String,
}) {}

it.effect("removes the released child when replacement acquisition fails", () =>
  Effect.gen(function* () {
    const resources = yield* makeAdvisorResourceState();
    let releases = 0;
    yield* resources.replaceChild(Effect.succeed("first"), () =>
      Effect.sync(() => {
        releases += 1;
      }),
    );

    const result = yield* resources
      .replaceChild(new AcquireFailure({ message: "expected" }), () => Effect.void)
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(releases).toBe(1);

    yield* resources.stopChild;
    expect(releases).toBe(1);
  }),
);

it.effect("serializes replacement and releases each installed child exactly once", () =>
  Effect.gen(function* () {
    const resources = yield* makeAdvisorResourceState();
    const releaseStarted = yield* Deferred.make<void>();
    const allowRelease = yield* Deferred.make<void>();
    const released: string[] = [];

    yield* resources.replaceChild(Effect.succeed("first"), (value) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(releaseStarted, undefined);
        yield* Deferred.await(allowRelease);
        released.push(value);
      }),
    );
    const replacement = yield* resources
      .replaceChild(Effect.succeed("second"), (value) =>
        Effect.sync(() => {
          released.push(value);
        }),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));

    yield* Deferred.await(releaseStarted);
    expect(released).toEqual([]);
    yield* Deferred.succeed(allowRelease, undefined);
    expect(yield* Fiber.join(replacement)).toBe("second");
    yield* resources.stopChild;
    yield* resources.stopChild;
    expect(released).toEqual(["first", "second"]);
  }),
);
