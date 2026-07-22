import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { SynchronousIngressError } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import { HostCallbackBoundary, makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import {
  emptyFooterRegistrySnapshot,
  FooterRegistryService,
  type FooterRegistryBridge,
} from "../src/footer/registry.ts";
import {
  FooterProtocolHost,
  makeFooterProtocolBuffer,
  type FooterProtocolEvent,
} from "../src/protocol/host.ts";

const text = (id: string): FooterProtocolEvent => ({
  _tag: "Upsert",
  owner: "owner",
  contribution: { kind: "text", id, region: "details", text: id },
});

function hostLayer(buffer: ReturnType<typeof makeFooterProtocolBuffer>) {
  const bridge: FooterRegistryBridge = {
    snapshot: emptyFooterRegistrySnapshot(),
    requestRenderNow: () => undefined,
    invalidate: () => undefined,
  };
  const registry = FooterRegistryService.layer({
    bridge,
    publish: (snapshot) => {
      bridge.snapshot = snapshot;
    },
  }).pipe(Layer.provide(HostCallbackBoundary.layer(makeHostCallbackBoundary())));
  return {
    bridge,
    layer: FooterProtocolHost.layer({ buffer }).pipe(Layer.provideMerge(registry)),
  };
}

const acquireHost = (
  layer: Layer.Layer<FooterProtocolHost | FooterRegistryService, SynchronousIngressError>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    Context.get(context, FooterProtocolHost);
    return { scope };
  });

describe("FooterProtocolHost", () => {
  it.effect("bounds pre-session events and drains retained events in order", () => {
    const buffer = makeFooterProtocolBuffer(2);
    buffer.offer(text("first"));
    buffer.offer(text("second"));
    buffer.offer(text("third"));
    expect(buffer.stats()).toMatchObject({ buffered: 2, dropped: 1, active: false });
    const { bridge, layer } = hostLayer(buffer);
    return Effect.acquireUseRelease(
      acquireHost(layer),
      () =>
        yieldUntil(() => bridge.snapshot.contributions.length === 2).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(bridge.snapshot.contributions.map((entry) => entry.id)).toEqual([
                "second",
                "third",
              ]);
              expect(buffer.stats()).toMatchObject({ buffered: 0, active: true });
            }),
          ),
        ),
      ({ scope }) => Scope.close(scope, Exit.void),
    );
  });

  it.effect("preserves pre-session upsert/remove ordering", () => {
    const buffer = makeFooterProtocolBuffer();
    buffer.offer(text("first"));
    buffer.offer({ _tag: "Remove", owner: "owner", id: "first" });
    buffer.offer(text("second"));
    const { bridge, layer } = hostLayer(buffer);
    return Effect.acquireUseRelease(
      acquireHost(layer),
      () =>
        yieldUntil(() => bridge.snapshot.contributions[0]?.id === "second").pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(bridge.snapshot.contributions[0]?.id).toBe("second");
            }),
          ),
        ),
      ({ scope }) => Scope.close(scope, Exit.void),
    );
  });

  it.effect("deactivates ingress and terminates its worker when the layer closes", () => {
    const buffer = makeFooterProtocolBuffer();
    const { layer } = hostLayer(buffer);
    return Effect.gen(function* () {
      const { scope } = yield* acquireHost(layer);
      expect(buffer.stats().active).toBe(true);
      yield* Scope.close(scope, Exit.void);
      expect(buffer.stats().active).toBe(false);
      expect(buffer.offer(text("after-close"))).toBe("accepted");
      expect(buffer.stats().buffered).toBe(1);
    });
  });

  it.effect("restores buffered events when startup is interrupted", () =>
    Effect.gen(function* () {
      const buffer = makeFooterProtocolBuffer(2);
      buffer.offer(text("first"));
      buffer.offer(text("second"));
      const started = yield* Deferred.make<void>();
      const blockedRegistry = Layer.succeed(
        FooterRegistryService,
        FooterRegistryService.of({
          upsert: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          remove: () => Effect.void,
          invalidate: () => Effect.void,
          setRenderRequest: () => Effect.void,
          clear: Effect.void,
          snapshot: emptyFooterRegistrySnapshot,
          requestRenderNow: () => undefined,
        }),
      );
      const interruptedLayer = FooterProtocolHost.layer({ buffer }).pipe(
        Layer.provide(blockedRegistry),
      );
      const interruptedScope = yield* Scope.make();
      const build = yield* Layer.buildWithScope(interruptedLayer, interruptedScope).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      expect(buffer.offer(text("third"))).toBe("accepted");
      yield* Fiber.interrupt(build);
      yield* Scope.close(interruptedScope, Exit.void);
      expect(buffer.stats()).toMatchObject({ buffered: 2, dropped: 1, active: false });

      const { bridge, layer } = hostLayer(buffer);
      yield* Effect.acquireUseRelease(
        acquireHost(layer),
        () =>
          yieldUntil(() => bridge.snapshot.contributions.length === 2).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(bridge.snapshot.contributions.map((entry) => entry.id)).toEqual([
                  "first",
                  "third",
                ]);
              }),
            ),
          ),
        ({ scope }) => Scope.close(scope, Exit.void),
      );
    }),
  );
});
