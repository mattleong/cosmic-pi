import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { freezeSnapshot, makeSynchronousIngress, ProjectionError } from "pi-cosmic-core";
import type { OpenAIConfigError, ResolvedConfig } from "../config/index.ts";
import { initialFastSnapshot, supportsFast, type FastSnapshot } from "./controller.ts";
import { OpenAIUsageService } from "../usage/index.ts";

export interface FastModeServiceShape {
  readonly initialize: (
    ctx: ExtensionContext,
    config: ResolvedConfig,
    flagActive: boolean,
  ) => Effect.Effect<void, OpenAIConfigError>;
  readonly setDesired: (
    ctx: ExtensionContext,
    desiredActive: boolean,
  ) => Effect.Effect<void, OpenAIConfigError>;
  readonly modelChanged: (ctx: ExtensionContext) => Effect.Effect<void, OpenAIConfigError>;
}

export class FastModeService extends Context.Service<FastModeService, FastModeServiceShape>()(
  "pi-better-openai/fast/service/FastModeService",
) {
  static layer(options: {
    readonly serviceTier: string;
    readonly projection: MutableRef.MutableRef<FastSnapshot>;
    readonly registerInjectionIngress: (
      offer: (event: { readonly model: string; readonly tier: string }) => void,
    ) => void;
  }): Layer.Layer<FastModeService, never, OpenAIUsageService> {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const usage = yield* OpenAIUsageService;
        const initialState = initialFastSnapshot();
        const state = yield* Ref.make(initialState);
        const transitionLock = yield* Semaphore.make(1);
        const prepareSnapshot = (next: FastSnapshot) =>
          Effect.try({
            try: () => freezeSnapshot(next),
            catch: () =>
              new ProjectionError({
                path: "$",
                message: "Unable to publish the fast-mode snapshot.",
              }),
          });
        const commitState = (next: FastSnapshot, snapshot: FastSnapshot) =>
          Ref.set(state, next).pipe(
            Effect.andThen(Effect.sync(() => MutableRef.set(options.projection, snapshot))),
          );
        yield* Effect.sync(() => MutableRef.set(options.projection, initialState));
        const commitInMemory = (update: (current: FastSnapshot) => FastSnapshot) =>
          transitionLock.withPermit(
            Effect.gen(function* () {
              const next = update(yield* Ref.get(state));
              const snapshot = yield* prepareSnapshot(next);
              yield* Effect.uninterruptible(commitState(next, snapshot));
            }),
          );
        const persistTransition = (update: (current: FastSnapshot) => FastSnapshot) =>
          transitionLock.withPermit(
            Effect.gen(function* () {
              const next = update(yield* Ref.get(state));
              const snapshot = yield* prepareSnapshot(next);
              yield* usage.persistFast(
                next.active,
                next.desiredActive,
                commitState(next, snapshot),
              );
            }),
          );
        const ingress = yield* makeSynchronousIngress({
          capacity: 16,
          overflow: "coalesce-latest",
          handle: (event: { readonly model: string; readonly tier: string }) =>
            commitInMemory((current) => ({
              ...current,
              lastInjectedModel: event.model,
              lastInjectedTier: event.tier,
            })).pipe(Effect.catchTag("ProjectionError", Effect.die)),
        }).pipe(Effect.orDie);
        options.registerInjectionIngress((event) => {
          ingress.offer(event);
        });
        const transition = (ctx: ExtensionContext, desiredActive: boolean) =>
          persistTransition((current) => ({
            ...current,
            desiredActive,
            active: desiredActive && supportsFast(ctx),
          })).pipe(Effect.catchTag("ProjectionError", Effect.die));

        return FastModeService.of({
          initialize: (ctx, config, flagActive) => {
            const desiredActive =
              flagActive || (config.persistState ? config.desiredActive : false);
            return transition(ctx, desiredActive);
          },
          setDesired: transition,
          modelChanged: (ctx) =>
            persistTransition((current) => ({
              ...current,
              active: current.desiredActive && supportsFast(ctx),
            })).pipe(Effect.catchTag("ProjectionError", Effect.die)),
        });
      }),
    );
  }
}
