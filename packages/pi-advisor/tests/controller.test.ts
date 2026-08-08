// Test entry point provides the controller Layer explicitly.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { advisorControllerLayer } from "../src/application/controller.ts";
import {
  AdvisorController,
  type AdvisorControllerApplicationOptions,
} from "../src/application/controller-types.ts";
import { advisorControllerApplicationLayer } from "../src/application/lifecycle.ts";
import { advisorPlatformLayer } from "../src/boundary/executor.ts";
import { makeAdvisorHostBindings } from "../src/boundary/host-bindings.ts";
import { captureAdvisorSessionInputEffect } from "../src/boundary/host-context.ts";
import { PiCommandAdapter } from "../src/boundary/host-commands.ts";
import { hostNotifierLayer } from "../src/boundary/host-notifier.ts";
import { failureLoggerLayer } from "../src/logging/logger.ts";
import { standaloneAdvisorExecutor } from "./support/executor.ts";
import { configStoreLayerFromLoad } from "./support/layers.ts";
import { advisorReviewQueueServiceLayer } from "../src/queue/service.ts";
import { AdvisorModelError } from "../src/runtime/client.ts";
import { AdvisorRuntimeService } from "../src/runtime/runtime.ts";

describe("AdvisorController", () => {
  it.effect("interrupts replacement acquisition and releases its scoped resource", () =>
    Effect.gen(function* () {
      const controller = yield* AdvisorController;
      let acquired = 0;
      let released = 0;
      const replacing = controller.replaceChild(
        Effect.scoped(
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired += 1;
              return "pending";
            }),
            () =>
              Effect.sync(() => {
                released += 1;
              }),
          ).pipe(Effect.andThen(Effect.never)),
        ),
        () => Effect.void,
      );
      const fiber = yield* replacing.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(acquired).toBe(1);
      expect(released).toBe(1);
    }).pipe(Effect.provide(advisorControllerLayer)),
  );

  it.effect("releases the active child when the Layer scope closes", () => {
    let releases = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(advisorControllerLayer);
        const controller = Context.get(context, AdvisorController);
        yield* controller.replaceChild(Effect.succeed("active"), () =>
          Effect.sync(() => {
            releases += 1;
          }),
        );
        expect(releases).toBe(0);
      }),
    ).pipe(Effect.andThen(Effect.sync(() => expect(releases).toBe(1))));
  });

  it.effect("owns real session config, child replacement, and shutdown state", () => {
    let starts = 0;
    let disposals = 0;
    const runtimeServiceStub = Layer.succeed(
      AdvisorRuntimeService,
      AdvisorRuntimeService.of({
        activeToolNames: () => [],
        start: () =>
          Effect.sync(() => {
            starts += 1;
          }),
        checkpoint: () => Effect.fail(new AdvisorModelError({ message: "unused" })),
        steer: () => Effect.succeed(true),
        reprime: () => Effect.void,
        abort: () => Effect.void,
        dispose: () =>
          Effect.sync(() => {
            disposals += 1;
          }),
      }),
    );
    const pi = {
      on: () => undefined,
      registerCommand: () => undefined,
      sendMessage: () => undefined,
      appendEntry: () => undefined,
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/project",
      mode: "tui",
      hasUI: true,
      signal: undefined,
      abort: () => undefined,
      hasPendingMessages: () => false,
      isIdle: () => true,
      isProjectTrusted: () => false,
      ui: { notify: () => undefined, setStatus: () => undefined },
      modelRegistry: { find: () => undefined },
      sessionManager: {
        buildContextEntries: () => [],
        getBranch: () => [],
        getLeafId: () => "root",
        getSessionId: () => "session",
      },
    } as unknown as ExtensionContext;
    const configStore = configStoreLayerFromLoad(() => ({
      configPath: "/tmp/pi-advisor-controller-test.json",
      enabled: true,
      provider: "provider",
      model: "model",
      setupDismissed: true,
      configured: true,
    }));
    const options: AdvisorControllerApplicationOptions = {
      pi,
      executor: standaloneAdvisorExecutor,
      dependencies: {
        configStore,
        runtimeService: runtimeServiceStub,
      },
      hostBindings: makeAdvisorHostBindings(),
    };
    const dependencies = Layer.mergeAll(
      runtimeServiceStub,
      advisorReviewQueueServiceLayer,
      PiCommandAdapter.layer,
      configStore,
      failureLoggerLayer,
      hostNotifierLayer,
    ).pipe(Layer.provideMerge(advisorPlatformLayer));
    const application = advisorControllerApplicationLayer(options).pipe(
      Layer.provideMerge(dependencies),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(application);
        const controller = Context.get(context, AdvisorController);
        const input = yield* captureAdvisorSessionInputEffect(ctx);
        yield* controller.sessionInitialize(undefined as never, input);
        expect(starts).toBe(1);
        expect(controller.getSnapshot().config.model).toBe("model");
        yield* controller.sessionInitialize(undefined as never, input);
        expect(starts).toBe(2);
        expect(disposals).toBe(1);
        yield* controller.sessionShutdown(undefined as never, ctx);
        expect(disposals).toBe(2);
        expect(controller.getSnapshot().started).toBe(false);
      }),
    );
  });
});
