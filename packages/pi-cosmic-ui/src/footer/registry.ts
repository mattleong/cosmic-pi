import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  CosmicFooterContribution,
  CosmicFooterSurfaceContribution,
} from "../protocol/protocol.ts";
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
  readonly setRenderRequest: (
    requestRender: (() => void) | undefined,
    expectedCurrent?: () => void,
  ) => Effect.Effect<void>;
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
  static layer(options: { readonly bridge: FooterRegistryBridge }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const callbacks = yield* HostCallbackBoundary;
        const state = yield* SynchronizedRef.make<RegistryState>({ entries: [] });
        const resources = new Map<string, Map<string, SurfaceResource>>();
        let requestRender: (() => void) | undefined;
        let renderSuppressionDepth = 0;
        let published = emptyFooterRegistrySnapshot();

        const publish = (next: RegistryState) => {
          published = snapshotOf(next);
          options.bridge.snapshot = published;
        };
        const renderNow = () => {
          if (renderSuppressionDepth > 0) return;
          if (requestRender) callbacks.invoke("request-render", requestRender, undefined);
        };
        const withRenderRequestsSuppressed = (action: () => void) => {
          renderSuppressionDepth++;
          try {
            action();
          } finally {
            renderSuppressionDepth--;
          }
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
            const scope = yield* Scope.make();
            const resource: SurfaceResource = { contribution, scope, attached: false };
            return yield* Effect.acquireRelease(Effect.succeed(resource), () =>
              Effect.sync(() => {
                detach(resource);
                if (contribution.dispose)
                  callbacks.invoke(
                    "surface-dispose",
                    contribution.dispose.bind(contribution),
                    undefined,
                  );
              }),
            ).pipe(Effect.provideService(Scope.Scope, scope));
          });
        const resourceValues = () => [...resources.values()].flatMap((byId) => [...byId.values()]);
        const setResource = (owner: string, id: string, resource: SurfaceResource) => {
          const byId = resources.get(owner) ?? new Map<string, SurfaceResource>();
          byId.set(id, resource);
          resources.set(owner, byId);
        };
        const takeResource = (owner: string, id: string) => {
          const byId = resources.get(owner);
          const resource = byId?.get(id);
          if (!resource) return undefined;
          byId?.delete(id);
          if (byId?.size === 0) resources.delete(owner);
          return resource;
        };
        const closeResource = (resource: SurfaceResource | undefined) =>
          resource ? Scope.close(resource.scope, Exit.void) : Effect.void;
        const closeResources = (values: readonly SurfaceResource[]) =>
          Effect.forEach(values, closeResource, { discard: true });
        const serialized = <A>(
          operation: (current: RegistryState) => Effect.Effect<readonly [A, RegistryState]>,
          lifecycle: {
            readonly beforePublish?: (result: A, next: RegistryState) => Effect.Effect<void>;
            readonly afterPublish?: (result: A, next: RegistryState) => Effect.Effect<void>;
          } = {},
        ) =>
          Effect.uninterruptible(
            SynchronizedRef.modifyEffect(state, (current) =>
              operation(current).pipe(
                Effect.flatMap(([result, next]) =>
                  (lifecycle.beforePublish?.(result, next) ?? Effect.void).pipe(
                    Effect.andThen(Effect.sync(() => publish(next))),
                    Effect.andThen(lifecycle.afterPublish?.(result, next) ?? Effect.void),
                    Effect.as([result, next] as const),
                  ),
                ),
              ),
            ),
          );

        const upsert: FooterRegistryServiceShape["upsert"] = (owner, contribution) =>
          serialized(
            (current) => {
              const index = current.entries.findIndex(
                (entry) => entry.owner === owner && entry.contribution.id === contribution.id,
              );
              const previous = index >= 0 ? current.entries[index]?.contribution : undefined;
              if (previous === contribution) {
                return Effect.succeed([
                  { previousResource: undefined, nextResource: undefined },
                  current,
                ] as const);
              }
              return Effect.gen(function* () {
                const nextResource =
                  contribution.kind === "surface" ? yield* acquire(contribution) : undefined;
                const previousResource = takeResource(owner, contribution.id);
                if (nextResource) setResource(owner, contribution.id, nextResource);
                const entry = { owner, contribution } as const;
                const entries = [...current.entries];
                if (index >= 0) entries[index] = entry;
                else entries.push(entry);
                return [{ previousResource, nextResource }, { entries }] as const;
              });
            },
            {
              beforePublish: ({ nextResource }) =>
                nextResource
                  ? Effect.sync(() => withRenderRequestsSuppressed(() => attach(nextResource)))
                  : Effect.void,
              afterPublish: ({ previousResource }) =>
                closeResource(previousResource).pipe(Effect.andThen(Effect.sync(renderNow))),
            },
          ).pipe(Effect.asVoid);

        const remove: FooterRegistryServiceShape["remove"] = (owner, id) =>
          serialized<{
            readonly changed: boolean;
            readonly resources: readonly SurfaceResource[];
          }>(
            (current) => {
              const removed = current.entries.filter(
                (entry) =>
                  entry.owner === owner && (id === undefined || entry.contribution.id === id),
              );
              if (removed.length === 0)
                return Effect.succeed([{ changed: false, resources: [] }, current] as const);
              const removedResources = removed.flatMap((entry) => {
                const resource = takeResource(entry.owner, entry.contribution.id);
                return resource ? [resource] : [];
              });
              return Effect.succeed([
                { changed: true, resources: removedResources },
                {
                  entries: current.entries.filter(
                    (entry) =>
                      entry.owner !== owner || (id !== undefined && entry.contribution.id !== id),
                  ),
                },
              ] as const);
            },
            {
              afterPublish: ({ changed, resources: removedResources }) =>
                closeResources(removedResources).pipe(
                  Effect.andThen(changed ? Effect.sync(renderNow) : Effect.void),
                ),
            },
          ).pipe(Effect.asVoid);

        const invalidate: FooterRegistryServiceShape["invalidate"] = (owner, id) =>
          serialized(
            (current) =>
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
                return [undefined, current] as const;
              }),
            { afterPublish: () => Effect.sync(renderNow) },
          );

        const setRenderRequest: FooterRegistryServiceShape["setRenderRequest"] = (
          next,
          expectedCurrent,
        ) =>
          serialized(
            (current) =>
              Effect.sync(() => {
                if (
                  next === undefined &&
                  expectedCurrent !== undefined &&
                  requestRender !== expectedCurrent
                )
                  return [false, current] as const;
                if (requestRender === next) return [false, current] as const;
                requestRender = undefined;
                for (const resource of resourceValues()) detach(resource);
                requestRender = next;
                return [true, current] as const;
              }),
            {
              afterPublish: (changed) =>
                changed
                  ? Effect.sync(() => {
                      withRenderRequestsSuppressed(() => {
                        for (const resource of resourceValues()) attach(resource);
                      });
                      renderNow();
                    })
                  : Effect.void,
            },
          ).pipe(Effect.asVoid);

        const clear = serialized(
          () =>
            Effect.sync(() => {
              const activeResources = resourceValues();
              resources.clear();
              requestRender = undefined;
              return [activeResources, { entries: [] }] as const;
            }),
          { afterPublish: (activeResources) => closeResources(activeResources) },
        );

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            options.bridge.snapshot = published;
            options.bridge.requestRenderNow = renderNow;
          }),
          () =>
            clear.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  const empty = emptyFooterRegistrySnapshot();
                  options.bridge.snapshot = empty;
                  options.bridge.requestRenderNow = () => undefined;
                }),
              ),
            ),
        );

        return FooterRegistryService.of({
          upsert,
          remove,
          invalidate,
          setRenderRequest,
          clear: clear.pipe(Effect.asVoid),
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
