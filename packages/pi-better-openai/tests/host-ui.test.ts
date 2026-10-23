import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { containCommandFailure } from "../src/boundary/host-ui.ts";
import { OpenAIBoundaryError } from "../src/usage/controller.ts";

const messages = {
  failed: () => "unavailable",
  unexpected: "unavailable",
  defect: "command defect",
};

for (const failure of ["typed", "defect"] as const) {
  it.effect(`retired ${failure} failure cannot notify before deferred runtime disposal`, () =>
    Effect.gen(function* () {
      let current = true;
      const notify = vi.fn();
      const ctx = extensionContextFixture({ ui: { notify } });
      const pi = extensionApiFixture({});
      const foreign = deferredPromise<number>();
      const admitted = deferredPromise();
      const disposal = deferredPromise();
      const slot = makePiSessionRuntimeSlot({
        makeRuntime: () => {
          const runtime = makePiManagedRuntime(pi, Layer.empty);
          return { ...runtime, dispose: () => disposal.promise.then(() => runtime.dispose()) };
        },
        startup: () => Effect.void,
        onDeactivated: () => {
          current = false;
        },
      });
      yield* Effect.promise(() => slot.start(undefined));
      const request = Effect.tryPromise({
        try: () => {
          admitted.resolve(undefined);
          return foreign.promise;
        },
        catch: () => OpenAIBoundaryError.make({ operation: "runtime", message: "unavailable" }),
      });
      const command =
        failure === "typed" ? request : request.pipe(Effect.catch(() => Effect.die("defect")));
      const work = slot.run(containCommandFailure(command, ctx, messages, () => current));
      try {
        yield* Effect.promise(() => admitted.promise);
        foreign.reject(new Error("foreign failure"));
        const shutdown = slot.shutdown();
        yield* Effect.promise(() => work);
        expect(notify).not.toHaveBeenCalled();
        disposal.resolve(undefined);
        yield* Effect.promise(() => shutdown);
      } finally {
        disposal.resolve(undefined);
        yield* Effect.promise(() => slot.shutdown());
      }
    }),
  );
}
