// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { AgentDirectory } from "pi-cosmic-core";
import { makeCapturedTracer, makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { CosmicUiConfigRepository } from "../src/config/repository.ts";

describe("CosmicUiConfigRepository", () => {
  it.effect("retains unknown document fields across updates", () => {
    const memory = makeInMemoryDocuments({
      "/project/.pi/extensions/pi-cosmic-ui.json": {
        future: true,
        footer: { enabled: true, futureFooter: 1 },
      },
    });
    const captured = makeCapturedTracer();
    const repository = CosmicUiConfigRepository.layer.pipe(
      Layer.provide(Layer.mergeAll(AgentDirectory.layer("/agent"), memory.layer, Path.layer)),
    );
    const layer = Layer.merge(repository, captured.layer);
    return Effect.gen(function* () {
      const repository = yield* CosmicUiConfigRepository;
      const current = yield* repository.resolve("/project");
      yield* repository.updateFooter("/project", { density: "compact" });
      expect(memory.documents.get(current.configPath)).toEqual({
        future: true,
        footer: { enabled: true, futureFooter: 1, density: "compact" },
      });
      const spanNames = captured.spans.map((span) => span.name);
      expect(spanNames).toEqual(
        expect.arrayContaining([
          "pi-cosmic-ui.config.resolve",
          "pi-cosmic-ui.config.update-footer",
        ]),
      );
      expect(spanNames.some((name) => name.startsWith("CosmicUiConfig."))).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
