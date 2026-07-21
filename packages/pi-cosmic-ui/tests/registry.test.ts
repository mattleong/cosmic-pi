import { describe, expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HostCallbackBoundary, makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import {
  emptyFooterRegistrySnapshot,
  FooterRegistryService,
  type FooterRegistryBridge,
  type FooterRegistryServiceShape,
} from "../src/footer/registry.ts";

function surface(overrides: Record<string, unknown> = {}) {
  return {
    kind: "surface" as const,
    id: "media",
    region: "media" as const,
    preferredWidth: 10,
    render: () => [],
    attach: vi.fn(),
    detach: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

function registryLayer(callbacks = makeHostCallbackBoundary()) {
  const bridge: FooterRegistryBridge = {
    snapshot: emptyFooterRegistrySnapshot(),
    requestRenderNow: () => undefined,
    invalidate: () => undefined,
  };
  const layer = FooterRegistryService.layer({
    bridge,
    publish: (snapshot) => {
      bridge.snapshot = snapshot;
    },
  }).pipe(Layer.provide(HostCallbackBoundary.layer(callbacks)));
  return { bridge, callbacks, layer };
}

const withRegistry = <A>(
  layer: Layer.Layer<FooterRegistryService>,
  use: (registry: FooterRegistryServiceShape) => Effect.Effect<A>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, scope);
      return { scope, registry: Context.get(context, FooterRegistryService) };
    }),
    ({ registry }) => use(registry),
    ({ scope }) => Scope.close(scope, Exit.void),
  );

describe("FooterRegistryService", () => {
  it.effect("keeps identifiers collision-safe and publishes a frozen renderer snapshot", () => {
    const { bridge, layer } = registryLayer();
    return withRegistry(layer, (registry) =>
      Effect.gen(function* () {
        yield* registry.upsert("a", {
          kind: "text",
          id: "b:c",
          region: "details",
          text: "first",
        });
        yield* registry.upsert("a:b", {
          kind: "text",
          id: "c",
          region: "details",
          text: "second",
        });
        expect(bridge.snapshot.contributions.map((entry) => entry.id)).toEqual(["b:c", "c"]);
        expect(Object.isFrozen(bridge.snapshot)).toBe(true);
        expect(Object.isFrozen(bridge.snapshot.contributions)).toBe(true);
        expect(Object.isFrozen(bridge.snapshot.contributions[0])).toBe(true);
        yield* registry.remove("a");
        expect(bridge.snapshot.contributions).toEqual([
          expect.objectContaining({ id: "c", text: "second" }),
        ]);
      }),
    );
  });

  it.effect("keeps NUL-containing owner/id pairs collision-free for surface resources", () => {
    const { layer } = registryLayer();
    const render = vi.fn();
    const first = surface({ id: "b\0c" });
    const second = surface({ id: "c" });
    return withRegistry(layer, (registry) =>
      Effect.gen(function* () {
        yield* registry.upsert("a", first);
        yield* registry.upsert("a\0b", second);
        yield* registry.setRenderRequest(render);
        expect(first.attach).toHaveBeenCalledOnce();
        expect(second.attach).toHaveBeenCalledOnce();
        expect(first.dispose).not.toHaveBeenCalled();
        expect(second.dispose).not.toHaveBeenCalled();

        yield* registry.remove("a", "b\0c");
        expect(first.detach).toHaveBeenCalledOnce();
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(second.detach).not.toHaveBeenCalled();
        expect(second.dispose).not.toHaveBeenCalled();

        yield* registry.remove("a\0b", "c");
        expect(second.detach).toHaveBeenCalledOnce();
        expect(second.dispose).toHaveBeenCalledOnce();
      }),
    );
  });

  it.effect("attaches, detaches, invalidates, replaces, and disposes exactly once", () => {
    const { layer } = registryLayer();
    const render = vi.fn();
    const first = surface();
    const second = surface();
    return withRegistry(layer, (registry) =>
      Effect.gen(function* () {
        yield* registry.upsert("owner", first);
        yield* registry.setRenderRequest(render);
        expect(first.attach).toHaveBeenCalledOnce();
        yield* registry.invalidate("owner", "media");
        expect(first.invalidate).toHaveBeenCalledOnce();
        yield* registry.upsert("owner", second);
        expect(first.detach).toHaveBeenCalledOnce();
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(second.attach).toHaveBeenCalledOnce();
        yield* registry.setRenderRequest(undefined);
        expect(second.detach).toHaveBeenCalledOnce();
        yield* registry.clear;
        yield* registry.clear;
        expect(second.dispose).toHaveBeenCalledOnce();
      }),
    );
  });

  it.effect("releases active surfaces when the service scope closes", () => {
    const { layer } = registryLayer();
    const active = surface();
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, scope);
      const registry = Context.get(context, FooterRegistryService);
      yield* registry.upsert("owner", active);
      yield* registry.setRenderRequest(() => undefined);
      yield* Scope.close(scope, Exit.void);
      expect(active.attach).toHaveBeenCalledOnce();
      expect(active.detach).toHaveBeenCalledOnce();
      expect(active.dispose).toHaveBeenCalledOnce();
    });
  });

  it.effect("isolates hostile callbacks and records only bounded operation diagnostics", () => {
    const callbacks = makeHostCallbackBoundary(2);
    const { layer } = registryLayer(callbacks);
    const hostile = surface({
      attach: () => {
        throw new Error("secret attach payload");
      },
      detach: () => {
        throw new Error("secret detach payload");
      },
      invalidate: () => {
        throw new Error("secret invalidate payload");
      },
      dispose: () => {
        throw new Error("secret dispose payload");
      },
    });
    return withRegistry(layer, (registry) =>
      Effect.gen(function* () {
        yield* registry.upsert("owner", hostile);
        yield* registry.setRenderRequest(() => {
          throw new Error("secret render payload");
        });
        yield* registry.invalidate();
        yield* registry.clear;
        const diagnostics = callbacks.diagnostics();
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics.every((entry) => Object.keys(entry).join() === "operation")).toBe(true);
        expect(diagnostics.some((entry) => "message" in entry)).toBe(false);
      }),
    );
  });
});
