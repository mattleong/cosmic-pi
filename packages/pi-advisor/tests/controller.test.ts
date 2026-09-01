import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AdvisorController,
  type AdvisorControllerApplicationOptions,
} from "../src/application/controller.ts";
import { advisorControllerApplicationLayer } from "../src/application/lifecycle/layer.ts";
import { advisorPlatformLayer } from "../src/boundary/executor.ts";
import { captureAdvisorSessionInputAtHostBoundary } from "../src/boundary/host-context.ts";
import { failureLoggerLayer } from "../src/logging/logger.ts";
import { AdvisorModelError } from "../src/runtime/client.ts";
import { AdvisorRuntimeService } from "../src/runtime/runtime.ts";
import { standaloneAdvisorExecutor } from "./support/executor.ts";
import { configStoreLayerFromLoad } from "./support/layers.ts";

describe("AdvisorController", () => {
  it.effect("owns real session config, child replacement, and shutdown state", () => {
    let starts = 0;
    let disposals = 0;
    const models: string[] = [];
    const runtimeServiceStub = Layer.succeed(
      AdvisorRuntimeService,
      AdvisorRuntimeService.of({
        activeToolNames: () => [],
        start: (options) =>
          Effect.sync(() => {
            starts += 1;
            models.push(options.config.model ?? "");
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
    const piFixture = {
      on: () => undefined,
      registerCommand: () => undefined,
      sendMessage: () => undefined,
      appendEntry: () => undefined,
    };
    // SAFETY: Controller registration uses only the four ExtensionAPI methods implemented here.
    const pi = piFixture as typeof piFixture & ExtensionAPI;
    const contextFixture = {
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
    };
    // SAFETY: This scenario exercises only the context fields implemented by the fixture.
    const ctx = contextFixture as typeof contextFixture & ExtensionContext;
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
    };
    const dependencies = Layer.mergeAll(runtimeServiceStub, configStore, failureLoggerLayer).pipe(
      Layer.provideMerge(advisorPlatformLayer),
    );
    const application = advisorControllerApplicationLayer(options).pipe(
      Layer.provideMerge(dependencies),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(application);
        const controller = Context.get(context, AdvisorController);
        const captured = captureAdvisorSessionInputAtHostBoundary(ctx);
        if (!captured.ok) return yield* captured.error;
        const input = captured.input;
        yield* controller.sessionInitialize(input);
        expect(starts).toBe(1);
        expect(models).toEqual(["model"]);
        yield* controller.sessionInitialize(input);
        expect(starts).toBe(2);
        expect(disposals).toBe(1);
        yield* controller.sessionShutdown();
        expect(disposals).toBe(2);
      }),
    );
  });
});
