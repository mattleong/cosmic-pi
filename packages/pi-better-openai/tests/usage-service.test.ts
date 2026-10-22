import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import { AgentDirectory, JsonHttpClient } from "pi-cosmic-core";
import { makeInMemoryDocuments, provideBuiltLayer } from "pi-cosmic-core/testing";
import type { ResolvedConfig } from "../src/config/schema.ts";
import { OpenAIConfigService } from "../src/config/store.ts";
import { OpenAIUsageService } from "../src/usage/controller.ts";
import { usageProjectionRef } from "../src/usage/projection.ts";
import { testContext } from "./helpers.ts";

const unusedHttp = JsonHttpClient.of({
  request: () => Effect.die("unexpected HTTP"),
  requestJson: () => Effect.die("unexpected HTTP"),
});

it.effect("refetches or clears usage only when its Cosmic UI visibility changes", () => {
  let visible = true;
  let changes = 0;
  const projection = usageProjectionRef();
  const platform = Layer.mergeAll(
    makeInMemoryDocuments().layer,
    Path.layer,
    AgentDirectory.layer("/agent"),
    Layer.succeed(JsonHttpClient, unusedHttp),
  );
  const config = OpenAIConfigService.layer({
    cwd: "/project",
    projection: MutableRef.make<ResolvedConfig | undefined>(undefined),
  });
  const layer = OpenAIUsageService.layer({
    context: MutableRef.make(testContext()),
    projection,
    onChange: () => void changes++,
    startPolling: false,
    isUsageVisible: () => visible,
  }).pipe(Layer.provideMerge(config), Layer.provide(platform));
  return Effect.gen(function* () {
    const usage = yield* OpenAIUsageService;
    const settled = changes;
    yield* usage.visibilityChanged();
    expect(changes).toBe(settled);

    visible = false;
    yield* usage.visibilityChanged();
    expect(MutableRef.get(projection)).toMatchObject({ eligible: false, snapshot: undefined });
    const hidden = changes;
    expect(hidden).toBeGreaterThan(settled);
    yield* usage.visibilityChanged();
    expect(changes).toBe(hidden);

    // Visible again, the refresh runs at once and reports the missing sign-in.
    visible = true;
    yield* usage.visibilityChanged();
    expect(MutableRef.get(projection).eligible).toBe(true);
    expect(MutableRef.get(projection).error).toBeDefined();
  }).pipe(provideBuiltLayer(layer));
});
