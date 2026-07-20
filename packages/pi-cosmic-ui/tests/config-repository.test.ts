// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  AgentDirectory,
  JsonDocumentStore,
  type JsonDocumentStoreShape,
  type JsonObject,
} from "pi-cosmic-core";
import { CosmicUiConfigRepository } from "../src/config/repository.ts";

describe("CosmicUiConfigRepository", () => {
  it.effect("retains unknown document fields across updates", () => {
    const values = new Map<string, JsonObject>([
      [
        "/project/.pi/extensions/pi-cosmic-ui.json",
        { future: true, footer: { enabled: true, futureFooter: 1 } },
      ],
    ]);
    const documents: JsonDocumentStoreShape = {
      exists: (path) => Effect.succeed(values.has(path)),
      readObject: (path) => Effect.succeed(values.get(path)),
      writeObject: (path, value) => Effect.sync(() => void values.set(path, value)),
      updateObject: (path, update) =>
        Effect.sync(() => {
          const next = update(values.get(path) ?? {});
          values.set(path, next);
          return next;
        }),
    };
    const layer = CosmicUiConfigRepository.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          AgentDirectory.layer("/agent"),
          Layer.succeed(JsonDocumentStore, documents),
          Path.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const repository = yield* CosmicUiConfigRepository;
      const current = yield* repository.resolve("/project");
      yield* repository.updateFooter("/project", current, { density: "compact" });
      expect(values.get(current.configPath)).toEqual({
        future: true,
        footer: { enabled: true, futureFooter: 1, density: "compact" },
      });
    }).pipe(Effect.provide(layer));
  });
});
