// Test entry point provides the controller Layer explicitly.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  _advisorControllerTest,
  AdvisorController,
  advisorControllerApplicationLayer,
  advisorControllerLayer,
  type AdvisorControllerApplicationOptions,
} from "../src/advisor-controller.ts";
import { advisorRuntimeServiceLayer, type AdvisorRuntimeDriver } from "../src/advisor-runtime.ts";
import { advisorReviewQueueServiceLayer } from "../src/review-queue.ts";
import { advisorPlatformLayer, standaloneAdvisorExecutor } from "../src/boundary/executor.ts";
import { captureAdvisorSessionInputEffect } from "../src/boundary/host-context.ts";
import { PiCommandAdapter } from "../src/pi-command-adapter.ts";
import { configRepositoryTestLayer } from "../src/config-repository.ts";
import { failureLoggerLayer } from "../src/failure-logger.ts";
import { hostNotifierLayer } from "../src/host-notifier.ts";
import { makeAdvisorHostBindings } from "../src/application/host-bindings.ts";

describe("AdvisorController", () => {
  it.effect("publishes immutable snapshots", () =>
    Effect.gen(function* () {
      const controller = yield* AdvisorController;
      const before = controller.getSnapshot();
      const next = { ...before, paused: true };
      yield* controller.publish(next);
      const published = controller.getSnapshot();
      expect(published).toEqual(next);
      expect(Object.isFrozen(published)).toBe(true);
      expect(Object.isFrozen(published.config)).toBe(true);
      expect(Object.isFrozen(published.metrics)).toBe(true);
    }).pipe(Effect.provide(advisorControllerLayer)),
  );

  it.effect("replaces and releases the authoritative child in order", () =>
    Effect.gen(function* () {
      const controller = yield* AdvisorController;
      const events: string[] = [];
      yield* controller.replaceChild(
        Effect.sync(() => {
          events.push("acquire:first");
          return "first";
        }),
        (child) => Effect.sync(() => events.push(`release:${child}`)),
      );
      yield* controller.replaceChild(
        Effect.sync(() => {
          events.push("acquire:second");
          return "second";
        }),
        (child) => Effect.sync(() => events.push(`release:${child}`)),
      );
      expect(events).toEqual(["acquire:first", "release:first", "acquire:second"]);
      yield* controller.stopChild();
      expect(events).toEqual([
        "acquire:first",
        "release:first",
        "acquire:second",
        "release:second",
      ]);
    }).pipe(Effect.provide(advisorControllerLayer)),
  );

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

  it.effect("keeps scoped finalization running when dependency driver cleanup rejects", () => {
    const events: string[] = [];
    const runtime = _advisorControllerTest.runtimeEffectsFromDriver({
      activeToolNames: [],
      start: () => Promise.resolve(),
      checkpoint: () => Promise.reject(new Error("unused")),
      steer: () => Promise.resolve(true),
      reprime: () => Promise.resolve(),
      abort: () => {
        events.push("abort");
        return Promise.reject(new Error("abort rejected"));
      },
      dispose: () => {
        events.push("dispose");
        return Promise.reject(new Error("dispose rejected"));
      },
    });

    return Effect.scoped(
      Effect.acquireRelease(Effect.void, () =>
        runtime.abort().pipe(
          Effect.andThen(runtime.dispose()),
          Effect.andThen(
            Effect.sync(() => {
              events.push("finalizer continued");
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => expect(events).toEqual(["abort", "dispose", "finalizer continued"])),
      ),
    );
  });

  it.effect("owns real session config, child replacement, and shutdown state", () => {
    let starts = 0;
    let disposals = 0;
    const driver: AdvisorRuntimeDriver = {
      get activeToolNames() {
        return [];
      },
      start: () => {
        starts += 1;
        return Promise.resolve();
      },
      checkpoint: () => Promise.reject(new Error("unused")),
      steer: () => Promise.resolve(true),
      reprime: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      dispose: () => {
        disposals += 1;
        return Promise.resolve();
      },
    };
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
    const options: AdvisorControllerApplicationOptions = {
      pi,
      executor: standaloneAdvisorExecutor,
      dependencies: {
        loadConfig: () => ({
          configPath: "/tmp/pi-advisor-controller-test.json",
          enabled: true,
          provider: "provider",
          model: "model",
          fastMode: false,
          thinkingLevel: "medium",
          reviewPolicy: "guardrail",
          timeoutMs: 30_000,
          maxContextChars: 48_000,
          configured: true,
        }),
        createRuntime: () => driver,
      },
      hostBindings: makeAdvisorHostBindings(),
    };
    const dependencies = Layer.mergeAll(
      advisorRuntimeServiceLayer(standaloneAdvisorExecutor),
      advisorReviewQueueServiceLayer,
      PiCommandAdapter.layer,
      configRepositoryTestLayer(options.dependencies.loadConfig!),
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
