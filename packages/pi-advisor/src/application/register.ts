/** Thin Pi registration boundary for the Advisor application. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  type PiSessionRuntimeSlot,
} from "pi-cosmic-core";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../boundary/executor.ts";
import { makeAdvisorHostBindings } from "../boundary/host-bindings.ts";
import {
  captureAdvisorSessionInputAtHostBoundary,
  type AdvisorSessionInput,
} from "../boundary/host-context.ts";
import { PiCommandAdapter } from "../boundary/host-commands.ts";
import { HostNotifier } from "../boundary/host-notifier.ts";
import { ConfigStore } from "../config/store.ts";
import { makeAdvisorApplicationLayer } from "../layer.ts";
import { FailureLogger } from "../logging/logger.ts";
import {
  AdvisorController,
  AdvisorExtensionError,
  type AdvisorControllerShape,
  type AdvisorExtensionDependencies,
} from "./controller-types.ts";
import { registerAdvisorReviewRenderer } from "../ui/renderer.ts";
import { AdvisorReviewQueueService } from "../queue/service.ts";
import { AdvisorRuntimeService } from "../runtime/runtime.ts";

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
  return function registerPersistentAdvisorExtension(pi: ExtensionAPI): void {
    registerAdvisorReviewRenderer(pi);
    const hostBindings = makeAdvisorHostBindings();
    let parentSlot!: PiSessionRuntimeSlot<
      AdvisorSessionInput,
      | AdvisorPlatform
      | AdvisorRuntimeService
      | AdvisorReviewQueueService
      | AdvisorController
      | ConfigStore
      | FailureLogger
      | HostNotifier
      | PiCommandAdapter,
      never
    >;
    const sessionExecutor: AdvisorEffectExecutor = {
      run: (effect, signal) => parentSlot.run(effect, signal),
      fork: (effect) => {
        const fiber = parentSlot.fork(effect);
        if (!fiber)
          throw new AdvisorExtensionError({
            operation: "session fork",
            message: "Advisor session runtime is not active.",
          });
        return fiber;
      },
      now: () => performance.now(),
    };
    const applicationLayer = makeAdvisorApplicationLayer({
      pi,
      executor: sessionExecutor,
      dependencies,
      hostBindings,
    });
    parentSlot = makePiSessionRuntimeSlot<
      AdvisorSessionInput,
      Layer.Success<typeof applicationLayer>,
      AdvisorExtensionError,
      Layer.Error<typeof applicationLayer>
    >({
      makeRuntime: () =>
        makePiManagedRuntime(pi, applicationLayer, {
          agentDirectory: getAgentDir,
          packageName: "pi-advisor",
        }),
      startup: (input) =>
        Effect.gen(function* () {
          const controller = yield* AdvisorController;
          yield* controller.sessionInitialize(undefined as never, input);
        }),
    });

    const runController = <A, E>(
      operation: (controller: AdvisorControllerShape) => Effect.Effect<A, E>,
    ): Promise<A> => parentSlot.run(Effect.flatMap(AdvisorController, operation));
    const ignoreFailure = <A>(promise: Promise<A>): Promise<void> =>
      promise.then(
        () => undefined,
        () => undefined,
      );
    const forwardEvent = (name: string, event: unknown, ctx: ExtensionContext): Promise<void> =>
      ignoreFailure(runController((controller) => controller.event(name, event as never, ctx)));

    for (const name of ["advisor", "advisor-settings", "advisor-status", "advisor-usage"]) {
      pi.registerCommand(name, {
        description: `Advisor ${name.replace("advisor", "").replace("-", " ").trim() || "control"}`,
        getArgumentCompletions: (prefix) =>
          hostBindings.commandDefinition(name)?.getArgumentCompletions?.(prefix) ?? null,
        handler: (args, ctx) => {
          const projected = hostBindings.commandHandler(name);
          if ((name === "advisor-status" || name === "advisor-usage") && projected) {
            return ignoreFailure(
              runController((controller) => controller.refreshProjection)
                .catch(() => undefined)
                .then(() => projected(args, ctx)),
            );
          }
          return ignoreFailure(runController((controller) => controller.command(name, args, ctx)));
        },
      });
    }

    pi.on("session_start", (_event, ctx) => {
      const captured = captureAdvisorSessionInputAtHostBoundary(ctx);
      return captured.ok
        ? parentSlot.start(captured.input, captured.input.signal).then(() => undefined)
        : parentSlot.shutdown().then(() => undefined);
    });
    pi.on("session_shutdown", (event, ctx) =>
      runController((controller) => controller.sessionShutdown(event as never, ctx))
        .catch(() => undefined)
        .then(() => parentSlot.shutdown()),
    );
    pi.on("session_compact", (event, ctx) =>
      ignoreFailure(runController((controller) => controller.compact(event as never, ctx))),
    );
    pi.on("session_tree", (event, ctx) =>
      ignoreFailure(runController((controller) => controller.tree(event as never, ctx))),
    );
    pi.on("message_end", (event, ctx) => forwardEvent("message_end", event, ctx));
    pi.on("turn_start", (event, ctx) => forwardEvent("turn_start", event, ctx));
    pi.on("message_update", (event, ctx) => forwardEvent("message_update", event, ctx));
    pi.on("tool_execution_start", (event, ctx) => forwardEvent("tool_execution_start", event, ctx));
    pi.on("tool_execution_update", (event, ctx) =>
      forwardEvent("tool_execution_update", event, ctx),
    );
    pi.on("tool_execution_end", (event, ctx) => forwardEvent("tool_execution_end", event, ctx));
    pi.on("agent_settled", (event, ctx) => forwardEvent("agent_settled", event, ctx));
    pi.on("turn_end", (event, ctx) => forwardEvent("turn_end", event, ctx));
  };
}

export const advisorExtension = createAdvisorExtension();
