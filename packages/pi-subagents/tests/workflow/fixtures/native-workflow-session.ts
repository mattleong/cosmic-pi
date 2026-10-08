// Public SDK/Promise boundary: actual Pi and QuickJS, offline inference and owned backend fakes.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { fauxCodemodeSession } from "pi-cosmic-core/testing/sdk";
import { Type } from "typebox";
import {
  registerUltracodeController,
  type UltracodeController,
} from "../../../src/application/ultracode.ts";
import { makeHostNotifier, type SubagentNotifier } from "../../../src/boundary/host-notifier.ts";
import { SubagentService } from "../../../src/run/service.ts";
import { registerWorkflowTool } from "../../../src/tools/workflow.ts";
import { WorkflowService } from "../../../src/workflow/service.ts";
import { declaredCandidate } from "../../fixtures/profiles.ts";
import { step } from "../../support/effect-test.ts";
import {
  memoryLocations,
  profileLayerFor,
  workflowFixture,
  type WorkflowFixtureOptions,
} from "./workflow-harness.ts";

const claudeProfiles = profileLayerFor({
  version: 6,
  defaultProfileSet: "default",
  profileSets: {
    default: {
      profiles: {
        generalist: [declaredCandidate("claude-native", { runtime: "claude" })],
        worker: [declaredCandidate("claude-native", { runtime: "claude", writeIntent: "writer" })],
      },
    },
  },
});

/** A real session, including ultracode's lifecycle gate, over the real workflow/run services. */
export const workflowSession = (
  options: WorkflowFixtureOptions & {
    readonly mode?: "on" | "only";
    readonly enabled?: boolean;
    readonly notifyConversation?: boolean;
    /** Pauses only the outer native script, after it has received its start receipt. */
    readonly barrier?: {
      readonly entered: Deferred.Deferred<void>;
      readonly interrupted: Deferred.Deferred<void>;
    };
  } = {},
) =>
  Effect.gen(function* () {
    let notifier: SubagentNotifier | undefined;
    let controller: UltracodeController | undefined;
    let context: ExtensionContext | undefined;
    const fixture = workflowFixture({
      profiles: claudeProfiles,
      ...options,
      ...(options.notifyConversation && { notify: (n) => notifier?.(n) }),
      observer: {
        opened: (id) => controller?.observer().opened(id),
        closed: (id, handoff) => controller?.observer().closed(id, handoff),
      },
    });
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => ManagedRuntime.make(Layer.merge(fixture.layer, fixture.backend.layer))),
      (managed) => step(() => managed.dispose()),
    );
    const base = yield* fauxCodemodeSession({
      prefix: "subagents-dynamic-workflow-",
      provider: "dynamic-workflow-test",
      prompt: "Exercise the workflow",
      reply: "Continuing with other work.",
      extension: {
        name: "subagents-dynamic-workflow-test",
        factory: (cwd) => (pi) => {
          controller = registerUltracodeController(pi);
          notifier = makeHostNotifier(pi);
          pi.on("session_start", (_event, ctx) => {
            context = ctx;
          });
          pi.on("session_shutdown", () => controller?.suspend());
          registerWorkflowTool(pi, {
            environment: { cwd, projectTrusted: false },
            savedWorkflowLocations: memoryLocations,
            run: (effect, signal) => runtime.runPromise(effect, signal ? { signal } : undefined),
          });
          const barrier = options.barrier;
          if (barrier)
            pi.registerTool({
              name: "workflow_fixture_barrier",
              label: "Fixture barrier",
              description: "Hold the native test script until cancellation.",
              parameters: Type.Object({}),
              execute: (_id, _args, signal) =>
                runtime.runPromise(
                  Deferred.succeed(barrier.entered, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(barrier.interrupted, undefined)),
                  ),
                  signal ? { signal } : undefined,
                ),
            });
        },
      },
    });
    if (!controller || !context)
      return yield* Effect.die(new Error("Pi did not bind the workflow extension context."));
    base.session.settingsManager.applyOverrides({ codemode: { mode: options.mode ?? "on" } });
    // Refresh Pi's native loadout after the in-memory settings override, without changing it.
    base.session.setActiveToolsByName(base.session.getActiveToolNames());
    controller.activate(context, options.enabled ?? true);
    const services = yield* step(() =>
      runtime.runPromise(Effect.all({ workflows: WorkflowService, subagents: SubagentService })),
    );
    return { ...base, fixture, ...services, controller };
  });
