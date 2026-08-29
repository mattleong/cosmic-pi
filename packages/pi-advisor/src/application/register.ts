/** Thin Pi registration and sole application Effect-to-Promise boundary. */
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
import { makeFooterStatusDeclaration } from "pi-cosmic-ui/boundary/host-status";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../boundary/executor.ts";
import { registerAdvisorReviewCardRendererAtHostBoundary } from "../boundary/host-review-cards.ts";
import {
  captureAdvisorSessionInputAtHostBoundary,
  type AdvisorSessionInput,
} from "../boundary/host-context.ts";
import { makeAdvisorApplicationLayer } from "../layer.ts";
import {
  ADVISOR_COMMAND_DESCRIPTION,
  completeAdvisorCommandArguments,
} from "../settings/controller.ts";
import {
  AdvisorController,
  AdvisorExtensionError,
  STATUS_KEY,
  type AdvisorApplicationEvent,
  type AdvisorControllerContract,
  type AdvisorExtensionDependencies,
} from "./controller.ts";

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
  return function registerPersistentAdvisorExtension(pi: ExtensionAPI): void {
    registerAdvisorReviewCardRendererAtHostBoundary(pi);
    const footerPlacement = makeFooterStatusDeclaration({
      events: pi.events,
      owner: STATUS_KEY,
      statusKey: STATUS_KEY,
      placement: { region: "identity", align: "right", priority: 100, order: 1000 },
    });
    let parentSlot!: PiSessionRuntimeSlot<
      AdvisorSessionInput,
      AdvisorPlatform | AdvisorController,
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
          yield* controller.sessionInitialize(input);
        }),
      onActivated: ({ ctx }) => footerPlacement.activate(ctx),
      onDeactivated: () => footerPlacement.shutdown(),
    });

    const runController = <A, E>(
      operation: (controller: AdvisorControllerContract) => Effect.Effect<A, E>,
    ): Promise<A> => parentSlot.run(Effect.flatMap(AdvisorController, operation));
    const ignoreFailure = <A>(promise: Promise<A>): Promise<void> =>
      promise.then(
        () => undefined,
        () => undefined,
      );
    const forwardEvent = (
      name: string,
      event: AdvisorApplicationEvent,
      ctx: ExtensionContext,
    ): Promise<void> =>
      ignoreFailure(runController((controller) => controller.event(name, event, ctx)));

    pi.registerCommand("advisor", {
      description: ADVISOR_COMMAND_DESCRIPTION,
      getArgumentCompletions: completeAdvisorCommandArguments,
      handler: (args, ctx) =>
        ignoreFailure(runController((controller) => controller.command(args, ctx))),
    });

    pi.on("session_start", (_event, ctx) => {
      const captured = captureAdvisorSessionInputAtHostBoundary(ctx);
      return captured.ok
        ? parentSlot.start(captured.input, captured.input.signal).then(() => undefined)
        : parentSlot.shutdown().then(() => undefined);
    });
    pi.on("session_shutdown", (_event, _ctx) =>
      runController((controller) => controller.sessionShutdown())
        .catch(() => undefined)
        .then(() => parentSlot.shutdown()),
    );
    pi.on("session_compact", (_event, ctx) =>
      ignoreFailure(runController((controller) => controller.compact(ctx))),
    );
    pi.on("session_tree", (_event, ctx) =>
      ignoreFailure(runController((controller) => controller.tree(ctx))),
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
