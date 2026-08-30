import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { freezeSnapshot, makeSynchronousIngress } from "pi-cosmic-core";
import type { ResolvedConfig } from "../config/schema.ts";
import { initialFastSnapshot, supportsFast, type FastSnapshot } from "./controller.ts";
import { OpenAIUsageService } from "../usage/controller.ts";

export interface FastInjectionEvent {
  readonly model: string;
  readonly tier: string;
}

export type FastInjectionIngress = (event: FastInjectionEvent) => void;

interface FastModeServiceOptions {
  readonly projection: MutableRef.MutableRef<FastSnapshot>;
}

type FastInitializationConfig = Pick<ResolvedConfig, "persistState" | "desiredActive">;

export class FastModeService extends Context.Service<FastModeService>()(
  "pi-better-openai/fast/service/FastModeService",
  {
    make: (options: FastModeServiceOptions) =>
      Effect.gen(function* () {
        const usage = yield* OpenAIUsageService;
        const initialState = initialFastSnapshot();
        const state = yield* Ref.make(initialState);
        const transitionLock = yield* Semaphore.make(1);
        const commitState = (snapshot: FastSnapshot) =>
          Ref.set(state, snapshot).pipe(
            Effect.andThen(Effect.sync(() => MutableRef.set(options.projection, snapshot))),
          );
        yield* Effect.sync(() => MutableRef.set(options.projection, initialState));
        const commitInMemory = (update: (current: FastSnapshot) => FastSnapshot) =>
          transitionLock.withPermit(
            Effect.gen(function* () {
              const snapshot = freezeSnapshot(update(yield* Ref.get(state)));
              yield* Effect.uninterruptible(commitState(snapshot));
            }),
          );
        const persistTransition = (update: (current: FastSnapshot) => FastSnapshot) =>
          transitionLock.withPermit(
            Effect.gen(function* () {
              const snapshot = freezeSnapshot(update(yield* Ref.get(state)));
              yield* usage.persistFast(
                snapshot.active,
                snapshot.desiredActive,
                commitState(snapshot),
              );
            }),
          );
        const ingress = yield* makeSynchronousIngress({
          capacity: 16,
          overflow: "coalesce-latest",
          handle: (event: FastInjectionEvent) =>
            commitInMemory((current) => ({
              ...current,
              lastInjectedModel: event.model,
              lastInjectedTier: event.tier,
            })),
        }).pipe(Effect.orDie);
        const transition = (ctx: ExtensionContext, desiredActive: boolean) =>
          persistTransition((current) => ({
            ...current,
            desiredActive,
            active: desiredActive && supportsFast(ctx),
          }));

        return {
          recordInjection: (event: FastInjectionEvent): void => {
            ingress.offer(event);
          },
          initialize: (
            ctx: ExtensionContext,
            config: FastInitializationConfig,
            flagActive: boolean,
          ) => {
            const desiredActive =
              flagActive || (config.persistState ? config.desiredActive : false);
            return transition(ctx, desiredActive);
          },
          setDesired: transition,
          modelChanged: (ctx: ExtensionContext) =>
            persistTransition((current) => ({
              ...current,
              active: current.desiredActive && supportsFast(ctx),
            })),
        };
      }),
  },
) {
  static layer(options: FastModeServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
