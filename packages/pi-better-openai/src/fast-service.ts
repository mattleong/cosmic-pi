import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { makeFrozenProjection, makeSynchronousIngress } from "pi-cosmic-core";
import type { OpenAIConfigError, ResolvedConfig } from "./config.ts";
import { supportsFast, type FastSnapshot } from "./fast-controller.ts";
import { OpenAIUsageService } from "./usage-controller.ts";

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
  "pi-better-openai/fast-service/FastModeService",
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
        const state = yield* makeFrozenProjection<FastSnapshot, FastSnapshot>(
          { desiredActive: false, active: false },
          (current) => current,
          (snapshot) => MutableRef.set(options.projection, snapshot),
        ).pipe(Effect.orDie);
        const ingress = yield* makeSynchronousIngress({
          capacity: 16,
          overflow: "coalesce-latest",
          handle: (event: { readonly model: string; readonly tier: string }) =>
            state
              .transition((current) =>
                Effect.succeed([
                  undefined,
                  {
                    ...current,
                    lastInjectedModel: event.model,
                    lastInjectedTier: event.tier,
                  },
                ] as const),
              )
              .pipe(Effect.asVoid),
        }).pipe(Effect.orDie);
        options.registerInjectionIngress((event) => {
          ingress.offer(event);
        });
        const transition = (ctx: ExtensionContext, desiredActive: boolean) =>
          state
            .transition((current) => {
              const next = {
                ...current,
                desiredActive,
                active: desiredActive && supportsFast(ctx),
              };
              return usage
                .persistFast(next.active, next.desiredActive)
                .pipe(Effect.as([undefined, next] as const));
            })
            .pipe(Effect.catchTag("ProjectionError", Effect.die), Effect.asVoid);

        return FastModeService.of({
          initialize: (ctx, config, flagActive) => {
            const desiredActive =
              flagActive || (config.persistState ? config.desiredActive : false);
            return transition(ctx, desiredActive);
          },
          setDesired: transition,
          modelChanged: (ctx) =>
            state
              .transition((current) => {
                const next = { ...current, active: current.desiredActive && supportsFast(ctx) };
                return usage
                  .persistFast(next.active, next.desiredActive)
                  .pipe(Effect.as([undefined, next] as const));
              })
              .pipe(Effect.catchTag("ProjectionError", Effect.die), Effect.asVoid),
        });
      }),
    );
  }
}
