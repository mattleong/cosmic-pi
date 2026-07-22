/** Unconfigured AdvisorController stub used before session application wiring. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { normalizeAdvisorConfig } from "../config/options.ts";
import { makeAdvisorResourceState } from "../runtime/resource-state.ts";
import { makeAdvisorProjection } from "../ui/projection.ts";
import { AdvisorController, AdvisorExtensionError } from "./controller-types.ts";
import { emptyAdvisorSessionMetrics } from "./state.ts";

export { AdvisorController, AdvisorExtensionError } from "./controller-types.ts";

export const advisorControllerLayer = Layer.effect(
  AdvisorController,
  Effect.gen(function* () {
    const resources = yield* makeAdvisorResourceState();
    const projection = yield* makeAdvisorProjection({
      config: normalizeAdvisorConfig({}, ""),
      metrics: emptyAdvisorSessionMetrics(),
      paused: false,
      started: false,
    });
    const unavailable = (operation: string) =>
      Effect.fail(
        new AdvisorExtensionError({
          operation,
          message: "Advisor application controller is not configured.",
        }),
      );
    const service = AdvisorController.of({
      getSnapshot: projection.getSnapshot,
      publish: (next) => projection.replace(next).pipe(Effect.orDie),
      refreshProjection: Effect.void,
      replaceChild: resources.replaceChild,
      stopChild: () => resources.stopChild,
      sessionInitialize: () => unavailable("session initialize"),
      sessionShutdown: () => unavailable("session shutdown"),
      event: (name) => unavailable(name),
      compact: () => unavailable("session compact"),
      tree: () => unavailable("session tree"),
      cancel: () => unavailable("cancel"),
      command: (name) => unavailable(`command ${name}`),
    });
    yield* Effect.addFinalizer(() => resources.stopChild);
    return service;
  }),
);
