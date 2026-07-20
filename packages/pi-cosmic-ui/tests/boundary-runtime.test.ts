// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCosmicUiRuntime } from "../src/boundary/runtime.ts";

class AcquiredResource extends Context.Service<AcquiredResource, { readonly ready: true }>()(
  "pi-cosmic-ui/tests/boundary-runtime.test/AcquiredResource",
) {}
class StalledLayer extends Context.Service<StalledLayer, { readonly ready: true }>()(
  "pi-cosmic-ui/tests/boundary-runtime.test/StalledLayer",
) {}

describe("Cosmic UI managed runtime boundary", () => {
  test("dispose interrupts stalled layer acquisition and releases acquired resources", async () => {
    let acquired = 0;
    let released = 0;
    const resource = Layer.effect(
      AcquiredResource,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired++;
          return AcquiredResource.of({ ready: true });
        }),
        () => Effect.sync(() => released++),
      ),
    );
    const stalled = Layer.effect(
      StalledLayer,
      Effect.never.pipe(Effect.as(StalledLayer.of({ ready: true }))),
    );
    const runtime = makeCosmicUiRuntime({} as ExtensionAPI, Layer.merge(resource, stalled));
    const running = runtime.run(StalledLayer.use(() => Effect.void)).then(
      () => false,
      () => true,
    );
    await vi.waitFor(() => expect(acquired).toBe(1));
    await runtime.dispose();
    expect(await running).toBe(true);
    expect(released).toBe(1);
    await runtime.dispose();
    expect(released).toBe(1);
  });
});
