import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { CosmicFooterContribution, CosmicFooterSurfaceContribution } from "../protocol.ts";
import { HostCallbackBoundary } from "../boundary/host-callback.ts";

interface RegistryEntry {
  readonly owner: string;
  readonly contribution: CosmicFooterContribution;
}

interface RegistryState {
  readonly entries: readonly RegistryEntry[];
}

export interface FooterRegistrySnapshot {
  readonly contributions: readonly CosmicFooterContribution[];
}

export const emptyFooterRegistrySnapshot = (): FooterRegistrySnapshot =>
  Object.freeze({ contributions: Object.freeze([]) });

const freezeContribution = (contribution: CosmicFooterContribution): CosmicFooterContribution =>
  Object.freeze({ ...contribution });

const snapshotOf = (state: RegistryState): FooterRegistrySnapshot =>
  Object.freeze({
    contributions: Object.freeze(
      state.entries.map((entry) => freezeContribution(entry.contribution)),
    ),
  });

interface SurfaceResource {
  readonly contribution: CosmicFooterSurfaceContribution;
  readonly scope: Scope.Closeable;
  attached: boolean;
}

export interface FooterRegistryServiceShape {
  readonly upsert: (owner: string, contribution: CosmicFooterContribution) => Effect.Effect<void>;
  readonly remove: (owner: string, id?: string) => Effect.Effect<void>;
  readonly invalidate: (owner?: string, id?: string) => Effect.Effect<void>;
  readonly setRenderRequest: (requestRender: (() => void) | undefined) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
  readonly snapshot: () => FooterRegistrySnapshot;
  readonly requestRenderNow: () => void;
}

export interface FooterRegistryBridge {
  snapshot: FooterRegistrySnapshot;
  requestRenderNow: () => void;
  invalidate: (owner?: string, id?: string) => void;
}

export class FooterRegistryService extends Context.Service<
  FooterRegistryService,
  FooterRegistryServiceShape
>()("pi-cosmic-ui/footer/registry/FooterRegistryService") {
  static layer(options: {
    readonly publish: (snapshot: FooterRegistrySnapshot) => void;
    readonly bridge: FooterRegistryBridge;
  }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const callbacks = yield* HostCallbackBoundary;
        const parentScope = yield* Effect.scope;
        const state = yield* SynchronizedRef.make<RegistryState>({ entries: [] });
        const resources = new Map<string, Map<string, SurfaceResource>>();
        let requestRender: (() => void) | undefined;
        let published = emptyFooterRegistrySnapshot();

        const publish = (next: RegistryState) => {
          published = snapshotOf(next);
          options.bridge.snapshot = published;
          options.publish(published);
        };
        const renderNow = () => {
          if (requestRender) callbacks.invoke("request-render", requestRender, undefined);
        };
        const detach = (resource: SurfaceResource) => {
          if (!resource.attached) return;
          resource.attached = false;
          if (resource.contribution.detach)
            callbacks.invoke(
              "surface-detach",
              resource.contribution.detach.bind(resource.contribution),
              undefined,
            );
        };
        const attach = (resource: SurfaceResource) => {
          if (resource.attached || !requestRender) return;
          resource.attached = true;
          if (resource.contribution.attach)
            callbacks.invoke(
              "surface-attach",
              () => resource.contribution.attach?.({ requestRender: renderNow }),
              undefined,
            );
        };
        const acquire = (contribution: CosmicFooterSurfaceContribution) =>
          Effect.gen(function* () {
            const scope = yield* Scope.fork(parentScope);
            const resource: SurfaceResource = { contribution, scope, attached: false };
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                detach(resource);
                if (contribution.dispose)
                  callbacks.invoke(
                    "surface-dispose",
                    contribution.dispose.bind(contribution),
                    undefined,
                  );
              }),
            );
            attach(resource);
            return resource;
          });
        const resourceValues = () => [...resources.values()].flatMap((byId) => [...byId.values()]);
        const setResource = (owner: string, id: string, resource: SurfaceResource) => {
          const byId = resources.get(owner) ?? new Map<string, SurfaceResource>();
          byId.set(id, resource);
          resources.set(owner, byId);
        };
        const releaseResource = (owner: string, id: string) => {
          const byId = resources.get(owner);
          const resource = byId?.get(id);
          if (!resource) return Effect.void;
          byId?.delete(id);
          if (byId?.size === 0) resources.delete(owner);
          return Scope.close(resource.scope, Exit.void);
        };
        const serialized = <A>(
          operation: (current: RegistryState) => Effect.Effect<readonly [A, RegistryState]>,
        ) =>
          SynchronizedRef.modifyEffect(state, (current) =>
            operation(current).pipe(Effect.tap(([, next]) => Effect.sync(() => publish(next)))),
          );

        const upsert: FooterRegistryServiceShape["upsert"] = (owner, contribution) =>
          serialized((current) => {
            const index = current.entries.findIndex(
              (entry) => entry.owner === owner && entry.contribution.id === contribution.id,
            );
            const previous = index >= 0 ? current.entries[index]?.contribution : undefined;
            if (previous === contribution) {
              renderNow();
              return Effect.succeed([undefined, current] as const);
            }
            return Effect.gen(function* () {
              yield* releaseResource(owner, contribution.id);
              if (contribution.kind === "surface")
                setResource(owner, contribution.id, yield* acquire(contribution));
              const entry = { owner, contribution } as const;
              const entries = [...current.entries];
              if (index >= 0) entries[index] = entry;
              else entries.push(entry);
              renderNow();
              return [undefined, { entries }] as const;
            });
          });

        const remove: FooterRegistryServiceShape["remove"] = (owner, id) =>
          serialized((current) => {
            const removed = current.entries.filter(
              (entry) =>
                entry.owner === owner && (id === undefined || entry.contribution.id === id),
            );
            if (removed.length === 0) return Effect.succeed([undefined, current] as const);
            return Effect.gen(function* () {
              yield* Effect.forEach(
                removed,
                (entry) => releaseResource(entry.owner, entry.contribution.id),
                { discard: true },
              );
              renderNow();
              return [
                undefined,
                {
                  entries: current.entries.filter(
                    (entry) =>
                      entry.owner !== owner || (id !== undefined && entry.contribution.id !== id),
                  ),
                },
              ] as const;
            });
          });

        const invalidate: FooterRegistryServiceShape["invalidate"] = (owner, id) =>
          serialized((current) =>
            Effect.sync(() => {
              for (const entry of current.entries) {
                if (owner !== undefined && entry.owner !== owner) continue;
                if (id !== undefined && entry.contribution.id !== id) continue;
                if (entry.contribution.kind === "surface" && entry.contribution.invalidate)
                  callbacks.invoke(
                    "surface-invalidate",
                    entry.contribution.invalidate.bind(entry.contribution),
                    undefined,
                  );
              }
              renderNow();
              return [undefined, current] as const;
            }),
          );

        const setRenderRequest: FooterRegistryServiceShape["setRenderRequest"] = (next) =>
          serialized((current) =>
            Effect.sync(() => {
              if (requestRender === next) return [undefined, current] as const;
              for (const resource of resourceValues()) detach(resource);
              requestRender = next;
              for (const resource of resourceValues()) attach(resource);
              renderNow();
              return [undefined, current] as const;
            }),
          );

        const clear = serialized(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              [...resources].flatMap(([owner, byId]) =>
                [...byId.keys()].map((id) => [owner, id] as const),
              ),
              ([owner, id]) => releaseResource(owner, id),
              { discard: true },
            );
            requestRender = undefined;
            return [undefined, { entries: [] }] as const;
          }),
        );

        options.bridge.snapshot = published;
        options.bridge.requestRenderNow = renderNow;
        options.publish(published);

        yield* Effect.addFinalizer(() =>
          clear.pipe(
            Effect.andThen(
              Effect.sync(() => {
                const empty = emptyFooterRegistrySnapshot();
                options.bridge.snapshot = empty;
                options.bridge.requestRenderNow = () => undefined;
                options.publish(empty);
              }),
            ),
          ),
        );

        return FooterRegistryService.of({
          upsert,
          remove,
          invalidate,
          setRenderRequest,
          clear,
          snapshot: () => published,
          requestRenderNow: renderNow,
        });
      }),
    );
  }
}

export const footerContributions = (snapshot: FooterRegistrySnapshot) => snapshot.contributions;
export const footerSurfaces = (snapshot: FooterRegistrySnapshot) =>
  snapshot.contributions.filter(
    (contribution): contribution is CosmicFooterSurfaceContribution =>
      contribution.kind === "surface",
  );
