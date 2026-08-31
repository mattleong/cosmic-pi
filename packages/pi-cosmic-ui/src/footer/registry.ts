import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { detachCosmicFooterContribution } from "../protocol/canonicalization.ts";
import type {
  CosmicFooterContribution,
  CosmicFooterSurfaceContribution,
} from "../protocol/protocol.ts";
import { HostCallbackBoundary } from "../boundary/host-callback.ts";

interface SurfaceResource {
  readonly contribution: CosmicFooterSurfaceContribution;
  readonly scope: Scope.Closeable;
  attached: boolean;
}

interface RegistryEntry {
  readonly owner: string;
  readonly contribution: CosmicFooterContribution;
  readonly resource?: SurfaceResource;
}

interface RegistryState {
  readonly entries: readonly RegistryEntry[];
}

export interface FooterRegistrySnapshot {
  readonly contributions: readonly CosmicFooterContribution[];
}

export const emptyFooterRegistrySnapshot = (): FooterRegistrySnapshot =>
  Object.freeze({ contributions: Object.freeze([]) });

const snapshotOf = (state: RegistryState): FooterRegistrySnapshot =>
  Object.freeze({
    contributions: Object.freeze(state.entries.map((entry) => entry.contribution)),
  });

export interface FooterRegistryServiceContract {
  readonly upsert: (owner: string, contribution: CosmicFooterContribution) => Effect.Effect<void>;
  readonly remove: (owner: string, id?: string) => Effect.Effect<void>;
  readonly invalidate: (owner?: string, id?: string) => Effect.Effect<void>;
  readonly setRenderRequest: (
    requestRender: (() => void) | undefined,
    expectedCurrent?: () => void,
  ) => Effect.Effect<void>;
}

export interface FooterRegistryBridge {
  snapshot: FooterRegistrySnapshot;
  requestRenderNow: () => void;
  invalidate: () => void;
}

export class FooterRegistryService extends Context.Service<
  FooterRegistryService,
  FooterRegistryServiceContract
>()("pi-cosmic-ui/footer/registry/FooterRegistryService") {
  static layer(options: { readonly bridge: FooterRegistryBridge }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const callbacks = yield* HostCallbackBoundary;
        const state = yield* SynchronizedRef.make<RegistryState>({ entries: [] });
        let requestRender: (() => void) | undefined;
        let renderSuppressionDepth = 0;

        const publish = (next: RegistryState) => {
          options.bridge.snapshot = snapshotOf(next);
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
          callbacks.invoke("surface-detach", () => resource.contribution.detach?.(), undefined);
        };
        const attach = (resource: SurfaceResource) => {
          if (resource.attached || !requestRender) return;
          resource.attached = true;
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
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                detach(resource);
                callbacks.invoke(
                  "surface-dispose",
                  () => resource.contribution.dispose?.(),
                  undefined,
                );
              }),
            );
            return resource;
          });
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
                    Effect.andThen(
                      next === current ? Effect.void : Effect.sync(() => publish(next)),
                    ),
                    Effect.andThen(lifecycle.afterPublish?.(result, next) ?? Effect.void),
                    Effect.as([result, next] as const),
                  ),
                ),
              ),
            ),
          );

        const upsert: FooterRegistryServiceContract["upsert"] = (owner, input) => {
          const contribution = detachCosmicFooterContribution(input);
          return serialized(
            (current) => {
              const index = current.entries.findIndex(
                (entry) => entry.owner === owner && entry.contribution.id === contribution.id,
              );
              const previous = index >= 0 ? current.entries[index] : undefined;
              if (previous?.contribution === contribution) {
                return Effect.succeed([
                  { previousResource: undefined, nextResource: undefined },
                  current,
                ] as const);
              }
              return Effect.gen(function* () {
                const nextResource =
                  contribution.kind === "surface" ? yield* acquire(contribution) : undefined;
                const previousResource = previous?.resource;
                const entry: RegistryEntry = nextResource
                  ? { owner, contribution, resource: nextResource }
                  : { owner, contribution };
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
        };

        const remove: FooterRegistryServiceContract["remove"] = (owner, id) =>
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
              const removedResources = removed.flatMap((entry) =>
                entry.resource ? [entry.resource] : [],
              );
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

        const invalidate: FooterRegistryServiceContract["invalidate"] = (owner, id) =>
          serialized(
            (current) =>
              Effect.sync(() => {
                for (const entry of current.entries) {
                  if (owner !== undefined && entry.owner !== owner) continue;
                  if (id !== undefined && entry.contribution.id !== id) continue;
                  const contribution = entry.contribution;
                  if (contribution.kind === "surface")
                    callbacks.invoke(
                      "surface-invalidate",
                      () => contribution.invalidate?.(),
                      undefined,
                    );
                }
                return [undefined, current] as const;
              }),
            { afterPublish: () => Effect.sync(renderNow) },
          );

        const setRenderRequest: FooterRegistryServiceContract["setRenderRequest"] = (
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
                for (const entry of current.entries) {
                  if (entry.resource) detach(entry.resource);
                }
                requestRender = next;
                return [true, current] as const;
              }),
            {
              afterPublish: (changed, nextState) =>
                changed
                  ? Effect.sync(() => {
                      withRenderRequestsSuppressed(() => {
                        for (const entry of nextState.entries) {
                          if (entry.resource) attach(entry.resource);
                        }
                      });
                      renderNow();
                    })
                  : Effect.void,
            },
          ).pipe(Effect.asVoid);

        const clear = serialized(
          (current) =>
            Effect.sync(() => {
              const activeResources = current.entries.flatMap((entry) =>
                entry.resource ? [entry.resource] : [],
              );
              requestRender = undefined;
              return [activeResources, { entries: [] }] as const;
            }),
          { afterPublish: (activeResources) => closeResources(activeResources) },
        );

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            options.bridge.snapshot = emptyFooterRegistrySnapshot();
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
        });
      }),
    );
  }
}

export const footerSurfaces = (snapshot: FooterRegistrySnapshot) =>
  snapshot.contributions.filter(
    (contribution): contribution is CosmicFooterSurfaceContribution =>
      contribution.kind === "surface",
  );
