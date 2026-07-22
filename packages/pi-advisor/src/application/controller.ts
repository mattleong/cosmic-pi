/** Public controller surface: types, stub service layer, and application composition. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { normalizeAdvisorConfig } from "../config/resolve.ts";
import { makeAdvisorResourceState } from "../runtime/resource-state.ts";
import { makeAdvisorProjection } from "../ui/projection.ts";
import { emptyAdvisorSessionMetrics } from "./state.ts";
import {
  AdvisorController,
  AdvisorExtensionError,
} from "./controller-types.ts";

export {
  ADVISOR_CATCH_UP_TIMEOUT_MS,
  AdvisorController,
  AdvisorExtensionError,
  awaitAdvisorCatchUpEffect,
  type AdvisorCatchUpOutcome,
  type AdvisorControllerApplicationOptions,
  type AdvisorControllerShape,
  type AdvisorExtensionDependencies,
  type AdvisorHostBindings,
  type AdvisorHostCommandDefinition,
  type AdvisorHostCommandHandler,
  type AdvisorHostEventHandler,
  type AdvisorSkipReason,
} from "./controller-types.ts";

export { advisorControllerApplicationLayer } from "./orchestration.ts";
export { _advisorControllerTest } from "./controller-helpers.ts";

/** Unconfigured controller placeholder used before session application wiring. */
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
