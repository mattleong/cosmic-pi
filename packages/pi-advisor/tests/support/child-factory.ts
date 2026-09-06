// Test harness boundary: session/model stubs are Promise-shaped Pi fixtures.
import type {
  createAgentSession,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { advisorPlatformLayer } from "../../src/boundary/executor.ts";
import type { ResolvedAdvisorConfig } from "../../src/config/options.ts";
import type { AdvisorChildModel } from "../../src/runtime/client.ts";
import {
  AdvisorChildFactory,
  type AdvisorChildFactoryContract,
} from "../../src/runtime/child-factory.ts";
import { toModelError } from "../../src/runtime/session.ts";
import { createAdvisorToolsEffect } from "../../src/runtime/tools.ts";

import type { AdvisorRuntimeStartOptions } from "../../src/runtime/runtime.ts";
import { resolvedAdvisorConfig } from "./config.ts";

export const testChildModel = () => ({
  // SAFETY: Runtime tests never invoke the model's provider implementation.
  modelRuntime: {} as never,
  // SAFETY: The fixture exercises identity only, not provider model capabilities.
  model: { provider: "p", id: "m" } as never,
  thinkingLevel: "medium" as const,
});

export const testRuntimeOptions = (
  overrides: Partial<AdvisorRuntimeStartOptions> = {},
): AdvisorRuntimeStartOptions => ({
  // SAFETY: Tests supply model creation through their child factory.
  ctx: { cwd: process.cwd(), modelRegistry: {} as never },
  config: resolvedAdvisorConfig({ configPath: "/tmp/config" }),
  seed: "seed",
  ...overrides,
});

export interface TestChildFactoryOverrides {
  readonly createChildModel?: (
    ctx: Pick<ExtensionContext, "modelRegistry">,
    config: ResolvedAdvisorConfig,
  ) => Promise<AdvisorChildModel>;
  readonly createTools?: (cwd: string) => Promise<readonly ToolDefinition[]>;
  readonly createSession?: typeof createAgentSession;
}

/**
 * Effect-shaped AdvisorChildFactory around Promise-shaped test fixtures. Tool creation
 * defaults to the production read-only tool Effects over the real platform.
 */
export const makeTestChildFactory = (
  overrides: TestChildFactoryOverrides = {},
): AdvisorChildFactoryContract => ({
  createChildModel: (ctx, config) =>
    overrides.createChildModel
      ? Effect.tryPromise({
          try: () => overrides.createChildModel!(ctx, config),
          catch: toModelError("Advisor model initialization failed."),
        })
      : Effect.fail(toModelError("Advisor test child model is not stubbed.")(undefined)),
  createTools: (cwd, runner) =>
    overrides.createTools
      ? Effect.tryPromise({
          try: () => overrides.createTools!(cwd),
          catch: toModelError("Advisor tools could not be created."),
        })
      : createAdvisorToolsEffect(cwd, runner).pipe(provideBuiltLayer(advisorPlatformLayer)),
  createSession: (options) =>
    overrides.createSession
      ? overrides.createSession(options)
      : Promise.reject(new Error("Advisor test child session is not stubbed.")),
});

/** Layer form of the Effect-shaped test child factory. */
export const childFactoryLayerFrom = (
  overrides: TestChildFactoryOverrides = {},
): Layer.Layer<AdvisorChildFactory> =>
  Layer.succeed(AdvisorChildFactory, AdvisorChildFactory.of(makeTestChildFactory(overrides)));
