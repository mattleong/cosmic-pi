// Effect-owned settings state and interruption assertions.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
import assert from "node:assert/strict";
import * as NodePath from "@effect/platform-node/NodePath";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { AgentDirectory, JsonDocumentStore } from "pi-cosmic-core";
import { CodePreviewEnvironmentService } from "./environment-service";
import { CodePreviewSettingsService } from "./service";

it.effect("interrupted settings loads finalize without publishing a partial snapshot", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let interrupted = 0;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(true),
      readObject: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => interrupted++)),
        ),
      writeObject: () => Effect.void,
      updateObject: (_path, update) => Effect.sync(() => update({})),
    });
    const dependencies = Layer.mergeAll(
      CodePreviewEnvironmentService.layerFrom({}),
      AgentDirectory.layer("/agent"),
      NodePath.layer,
      Layer.succeed(JsonDocumentStore, documents),
    );
    const layer = CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies));
    const fiber = yield* CodePreviewSettingsService.use((service) => service.load()).pipe(
      Effect.provide(layer),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    assert.equal(interrupted, 1);
  }).pipe(Effect.scoped),
);
