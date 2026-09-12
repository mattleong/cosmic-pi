import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { OwnedFormCapability } from "pi-ask-user/protocol";
import { makeAskUserHost } from "../../src/boundary/host-ask-user.ts";

const owner = {
  extensionId: "pi-mcp",
  operationId: "operation",
  requestId: "request",
  label: "MCP fixture",
};
const host = (capability: OwnedFormCapability) =>
  makeAskUserHost(
    {
      events: {
        on: () => () => {},
        emit: (_event, data) => {
          // SAFETY: this owned mock receives only queryOwnedFormCapability's synchronous query.
          const query = data as { respond: (value: OwnedFormCapability) => void };
          query.respond(capability);
        },
      },
      exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "", killed: false }),
    },
    "session",
    () => true,
  );

it.live(
  "cancellation bounds only the foreign cleanup waiter and fences replacement runtimes until exact settlement",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const pending = yield* Deferred.make<void>();
      // Named foreign capability callbacks inherit test services; no production runner is added.
      const runForeign = Effect.runPromiseWith(yield* Effect.context<never>());
      let cancelledOwner: unknown;
      const capability: OwnedFormCapability = {
        version: 1,
        sessionId: "session",
        generation: "one",
        ask: (_request, _owner, signal) => {
          Deferred.doneUnsafe(entered, Effect.void);
          return runForeign(Effect.never, { signal }).catch(() => ({ action: "cancel" as const }));
        },
        cancel: (exactOwner) => {
          cancelledOwner = exactOwner;
          return runForeign(Deferred.await(pending));
        },
      };
      yield* Effect.gen(function* () {
        const provider = yield* host(capability).resolve;
        expect(provider).toBeDefined();
        const asking = yield* Effect.forkScoped(
          provider!.ask({ kind: "form", message: "Choose", fields: [] }, owner),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(asking).pipe(Effect.timeout(2_000));
        expect(cancelledOwner).toBe(owner);
        expect(yield* host(capability).resolve).toBeUndefined();
        yield* Deferred.succeed(pending, undefined);
        yield* Effect.sleep(1);
        expect(yield* host(capability).resolve).toBeDefined();
      }).pipe(Effect.ensuring(Deferred.succeed(pending, undefined)));
    }),
);

it.live("rejected exact cleanup remains fail closed across replacement runtimes", () =>
  Effect.gen(function* () {
    const capability: OwnedFormCapability = {
      version: 1,
      sessionId: "session",
      generation: "two",
      ask: () => Promise.resolve({ action: "decline" as const }),
      cancel: () => Promise.reject(new Error("foreign cleanup failure")),
    };
    const provider = yield* host(capability).resolve;
    expect(
      yield* provider!
        .ask({ kind: "form", message: "Choose", fields: [] }, owner)
        .pipe(Effect.flip),
    ).toMatchObject({ kind: "cleanup", outcome: "unknown" });
    expect(yield* host(capability).resolve).toBeUndefined();
  }),
);
