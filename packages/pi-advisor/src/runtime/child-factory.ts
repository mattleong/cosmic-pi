// The Context key intentionally mirrors the runtime module identity.
// @effect-diagnostics effect/deterministicKeys:off
import {
  createAgentSession,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AdvisorPlatform } from "../boundary/executor.ts";
import type { ResolvedAdvisorConfig } from "../config/options.ts";
import {
  createAdvisorChildModelEffect,
  type AdvisorChildModel,
  type AdvisorModelError,
} from "./client.ts";
import {
  createAdvisorToolsEffect,
  type AdvisorToolRunner,
  type AdvisorToolSafetyError,
} from "./tools.ts";

/**
 * Effect Context service for advisor child construction: model runtime, read-only tools,
 * and the child AgentSession. `createSession` is the Pi host boundary and stays
 * Promise-shaped because `createAgentSession` is.
 */
export interface AdvisorChildFactoryContract {
  readonly createChildModel: (
    ctx: Pick<ExtensionContext, "modelRegistry">,
    config: ResolvedAdvisorConfig,
  ) => Effect.Effect<AdvisorChildModel, AdvisorModelError>;
  readonly createTools: (
    cwd: string,
    runner: AdvisorToolRunner,
  ) => Effect.Effect<readonly ToolDefinition[], AdvisorModelError | AdvisorToolSafetyError>;
  readonly createSession: typeof createAgentSession;
}

export class AdvisorChildFactory extends Context.Service<
  AdvisorChildFactory,
  AdvisorChildFactoryContract
>()("pi-advisor/runtime/child-factory/AdvisorChildFactory") {}

/** Production child construction; tests provide Effect-shaped layers under tests/support. */
export const advisorChildFactoryLayer: Layer.Layer<AdvisorChildFactory, never, AdvisorPlatform> =
  Layer.effect(
    AdvisorChildFactory,
    Effect.gen(function* () {
      const platform = yield* Effect.context<AdvisorPlatform>();
      return AdvisorChildFactory.of({
        createChildModel: createAdvisorChildModelEffect,
        createTools: (cwd, runner) =>
          createAdvisorToolsEffect(cwd, runner).pipe(Effect.provide(platform)),
        createSession: createAgentSession,
      });
    }),
  );
