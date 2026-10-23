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
import { OpenAIConfigService } from "../config/store.ts";

export interface FastInjectionEvent {
  readonly model: string;
  readonly tier: string;
}

export type FastInjectionIngress = (event: FastInjectionEvent) => void;

const desire =
  (ctx: ExtensionContext, desiredActive: boolean) =>
  (current: FastSnapshot): FastSnapshot => ({
    ...current,
    desiredActive,
    active: desiredActive && supportsFast(ctx),
  });

interface FastModeServiceOptions {
  readonly projection: MutableRef.MutableRef<FastSnapshot>;
  readonly canPublish?: () => boolean;
}

export class FastModeService extends Context.Service<FastModeService>()(
  "pi-better-openai/fast/service/FastModeService",
  {
    make: Effect.fn("FastModeService.make")(function* (options: FastModeServiceOptions) {
      const configStore = yield* OpenAIConfigService;
      const initialState = initialFastSnapshot();
      const state = yield* Ref.make(initialState);
      const transitions = yield* Semaphore.make(1);
      const publish = (snapshot: FastSnapshot) => {
        if (options.canPublish?.() !== false) MutableRef.set(options.projection, snapshot);
      };
      yield* Effect.sync(() => publish(initialState));
      const commit = (snapshot: FastSnapshot) =>
        Effect.uninterruptible(
          Effect.sync(() => publish(snapshot)).pipe(Effect.andThen(Ref.set(state, snapshot))),
        );
      const prepare = (update: (current: FastSnapshot) => FastSnapshot) =>
        Ref.get(state).pipe(Effect.map((current) => freezeSnapshot(update(current))));
      const commitInMemory = (update: (current: FastSnapshot) => FastSnapshot) =>
        transitions.withPermit(prepare(update).pipe(Effect.flatMap(commit)));
      const persistTransition = (update: (current: FastSnapshot) => FastSnapshot) =>
        transitions.withPermit(
          prepare(update).pipe(
            Effect.flatMap((snapshot) =>
              configStore.persistFast(snapshot.desiredActive, commit(snapshot)),
            ),
          ),
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
      return {
        recordInjection: (event: FastInjectionEvent): void => {
          ingress.offer(event);
        },
        initialize: (
          ctx: ExtensionContext,
          config: Pick<ResolvedConfig, "persistState" | "desiredActive">,
          flagActive: boolean,
        ) => {
          const persisted = config.persistState && config.desiredActive;
          const update = desire(ctx, flagActive || persisted);
          return flagActive && !persisted ? persistTransition(update) : commitInMemory(update);
        },
        setDesired: (ctx: ExtensionContext, desiredActive: boolean) =>
          persistTransition(desire(ctx, desiredActive)),
        modelChanged: (ctx: ExtensionContext) =>
          commitInMemory((current) => desire(ctx, current.desiredActive)(current)),
      };
    }),
  },
) {
  static layer(options: FastModeServiceOptions) {
    return Layer.effect(this, this.make(options));
  }
}
