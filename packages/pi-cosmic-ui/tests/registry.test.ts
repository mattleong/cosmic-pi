import { describe, expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HostCallbackBoundary, makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import type { CosmicFooterSurfaceContribution } from "../src/protocol/protocol.ts";
import {
  emptyFooterRegistrySnapshot,
  FooterRegistryService,
  type FooterRegistryBridge,
  type FooterRegistryServiceContract,
} from "../src/footer/registry.ts";

const baseSurface = () =>
  ({
    kind: "surface" as const,
    id: "media",
    region: "media" as const,
    preferredWidth: 10,
    render: () => [],
    attach: vi.fn(),
    detach: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  }) satisfies CosmicFooterSurfaceContribution;

type SurfaceOverride = Partial<Omit<CosmicFooterSurfaceContribution, "kind" | "region">>;
type SurfaceFixture<Override extends SurfaceOverride> = Omit<
  ReturnType<typeof baseSurface>,
  keyof Override
> &
  Override;

function surface<Override extends SurfaceOverride = object>(
  overrides?: Override,
): SurfaceFixture<Override> {
  const fixture = { ...baseSurface(), ...overrides };
  // SAFETY: The merged fixture preserves the base surface and applies the declared override type.
  return fixture as typeof fixture & SurfaceFixture<Override>;
}

function registryLayer(callbacks = makeHostCallbackBoundary()) {
  const bridge: FooterRegistryBridge = {
    snapshot: emptyFooterRegistrySnapshot(),
    requestRenderNow: () => undefined,
    invalidate: () => undefined,
  };
  const layer = FooterRegistryService.layer({ bridge }).pipe(
    Layer.provide(HostCallbackBoundary.layer(callbacks)),
  );
  return { bridge, callbacks, layer };
}

const withRegistry = <A>(
  layer: Layer.Layer<FooterRegistryService>,
  use: (registry: FooterRegistryServiceContract) => Effect.Effect<A>,
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

  it.effect("does not let a stale owner clear a replacement render request", () => {
    const { layer } = registryLayer();
    const active = surface();
    const first = vi.fn();
    const second = vi.fn();
    return withRegistry(layer, (registry) =>
      Effect.gen(function* () {
        yield* registry.upsert("owner", active);
        yield* registry.setRenderRequest(first);
        yield* registry.setRenderRequest(second);
        active.detach.mockClear();
        second.mockClear();

        yield* registry.setRenderRequest(undefined, first);
        expect(active.detach).not.toHaveBeenCalled();
        registry.requestRenderNow();
        expect(second).toHaveBeenCalledOnce();
      }),
    );
  });

  it.effect("publishes snapshots before synchronous lifecycle render requests", () => {
    const { bridge, layer } = registryLayer();
    const observed: string[][] = [];
    let requestFromSurface: () => void = () => undefined;
    const active = surface({
      attach: vi.fn((host: { requestRender(): void }) => {
        requestFromSurface = host.requestRender;
        host.requestRender();
      }),
      detach: vi.fn(() => requestFromSurface()),
    });
    return withRegistry(layer, (registry) =>
      Effect.gen(function* () {
        yield* registry.setRenderRequest(() => {
          observed.push(bridge.snapshot.contributions.map((entry) => entry.id));
        });
        observed.length = 0;

        yield* registry.upsert("owner", active);
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.every((ids) => ids.join() === "media")).toBe(true);

        observed.length = 0;
        yield* registry.remove("owner", "media");
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.every((ids) => ids.length === 0)).toBe(true);
      }),
    );
  });

  it.effect("waits for every surface to attach before rendering a registered snapshot", () => {
    const { layer } = registryLayer();
    let firstAttached = false;
    let secondAttached = false;
    const first = surface({
      id: "first",
      attach: vi.fn((host: { requestRender(): void }) => {
        firstAttached = true;
        host.requestRender();
      }),
    });
    const second = surface({
      id: "second",
      attach: vi.fn((host: { requestRender(): void }) => {
        secondAttached = true;
        host.requestRender();
      }),
    });
    const observations: Array<readonly [boolean, boolean]> = [];
    return withRegistry(layer, (registry) =>
      Effect.gen(function* () {
        yield* registry.upsert("owner", first);
        yield* registry.upsert("owner", second);

        yield* registry.setRenderRequest(() => {
          observations.push([firstAttached, secondAttached]);
        });

        expect(first.attach).toHaveBeenCalledOnce();
        expect(second.attach).toHaveBeenCalledOnce();
        expect(observations).toEqual([[true, true]]);
      }),
    );
  });

  it.effect("keeps detach-triggered replacement renders on an attached surface", () => {
    const { bridge, layer } = registryLayer();
    let firstAttached = false;
    let secondAttached = false;
    let requestFromFirst: () => void = () => undefined;
    const firstRender = () => [];
    const secondRender = () => [];
    const first = surface({
      render: firstRender,
      attach: vi.fn((host: { requestRender(): void }) => {
        firstAttached = true;
        requestFromFirst = host.requestRender;
      }),
      detach: vi.fn(() => {
        firstAttached = false;
        requestFromFirst();
      }),
    });
    const second = surface({
      render: secondRender,
      attach: vi.fn(() => {
        secondAttached = true;
      }),
      detach: vi.fn(() => {
        secondAttached = false;
      }),
    });
    const observations: Array<{
      readonly surface: "first" | "second" | "none";
      readonly firstAttached: boolean;
      readonly secondAttached: boolean;
    }> = [];
    return withRegistry(layer, (registry) =>
      Effect.gen(function* () {
        yield* registry.upsert("owner", first);
        yield* registry.setRenderRequest(() => {
          const current = bridge.snapshot.contributions[0];
          observations.push({
            surface:
              current?.kind !== "surface"
                ? "none"
                : current.render === firstRender
                  ? "first"
                  : current.render === secondRender
                    ? "second"
                    : "none",
            firstAttached,
            secondAttached,
          });
        });
        observations.length = 0;

        yield* registry.upsert("owner", second);

        expect(first.detach).toHaveBeenCalledOnce();
        expect(second.attach).toHaveBeenCalledOnce();
        expect(observations.length).toBeGreaterThan(0);
        expect(
          observations.every(({ surface, firstAttached, secondAttached }) =>
            surface === "first" ? firstAttached : surface === "second" ? secondAttached : false,
          ),
        ).toBe(true);
        expect(observations.every(({ surface }) => surface === "second")).toBe(true);
      }),
    );
  });

  it.effect("suppresses detach-triggered renders when the service scope closes", () => {
    const { bridge, layer } = registryLayer();
    let requestFromSurface: () => void = () => undefined;
    const active = surface({
      attach: vi.fn((host: { requestRender(): void }) => {
        requestFromSurface = host.requestRender;
      }),
      detach: vi.fn(() => requestFromSurface()),
    });
    const render = vi.fn();
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, scope);
      const registry = Context.get(context, FooterRegistryService);
      yield* registry.upsert("owner", active);
      yield* registry.setRenderRequest(render);
      expect(render).toHaveBeenCalledOnce();
      yield* Scope.close(scope, Exit.void);
      expect(active.attach).toHaveBeenCalledOnce();
      expect(active.detach).toHaveBeenCalledOnce();
      expect(active.dispose).toHaveBeenCalledOnce();
      expect(bridge.snapshot).toEqual(emptyFooterRegistrySnapshot());
      bridge.requestRenderNow();
      expect(render).toHaveBeenCalledOnce();
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
