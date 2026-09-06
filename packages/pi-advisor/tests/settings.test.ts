import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vitest";
import {
  normalizeAdvisorConfig,
  patchAdvisorConfig,
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
} from "../src/config/options.ts";
import { emptyAdvisorSessionMetrics, type AdvisorSessionMetrics } from "../src/domain/metrics.ts";
import {
  completeAdvisorCommandArguments,
  handleAdvisorCommand,
} from "../src/settings/controller.ts";
import type {
  AdvisorActivity,
  AdvisorCommandActions,
  AdvisorCommandState,
} from "../src/settings/types.ts";
import { deferred } from "./support/async.ts";

function harness(
  initial: ResolvedAdvisorConfig = normalizeAdvisorConfig(
    { enabled: true, provider: "p", model: "m", setupDismissed: true },
    "/config",
  ),
  snapshot: {
    readonly activity?: AdvisorActivity;
    readonly hasLastCandidate?: boolean;
    readonly metrics?: AdvisorSessionMetrics;
  } = {},
) {
  let config = initial;
  const persist = vi.fn((patch: AdvisorConfigPatch) =>
    Effect.sync(() => {
      const base = { enabled: config.enabled, setupDismissed: config.setupDismissed };
      const withProvider = config.provider ? { ...base, provider: config.provider } : base;
      const patched = config.model ? { ...withProvider, model: config.model } : withProvider;
      const raw = patchAdvisorConfig(patched, patch);
      config = normalizeAdvisorConfig(raw, config.configPath);
      return config;
    }),
  );
  const actions: AdvisorCommandActions = {
    cancel: vi.fn(() => Effect.succeed(false)),
    fixLast: vi.fn(() => "unavailable" as const),
    dismissLast: vi.fn(() => "unavailable" as const),
    reviewLast: vi.fn(() => Effect.succeed("started" as const)),
  };
  const handler = (args: string, ctx: ExtensionCommandContext) => {
    const state: AdvisorCommandState = {
      snapshot: {
        config,
        metrics: snapshot.metrics ?? emptyAdvisorSessionMetrics(),
        activity: snapshot.activity ?? "idle",
        hasLastCandidate: snapshot.hasLastCandidate ?? false,
      },
      persist,
    };
    return handleAdvisorCommand(args, ctx, state, actions);
  };
  return {
    handler,
    actions,
    persist,
    getConfig: () => config,
    setConfig: (next: ResolvedAdvisorConfig) => {
      config = next;
    },
  };
}

function context(
  options: {
    mode?: "tui" | "rpc";
    selections?: Array<string | undefined>;
    models?: Array<{ provider: string; id: string }>;
  } = {},
) {
  const selections = [...(options.selections ?? [])];
  const notify = vi.fn();
  const fixture = {
    mode: options.mode ?? "tui",
    hasUI: true,
    ui: {
      notify,
      select: vi.fn(() => Promise.resolve(selections.shift())),
    },
    modelRegistry: {
      getAvailable: vi.fn(() => options.models ?? []),
      find: vi.fn((provider: string, model: string) => ({ provider, id: model })),
      hasConfiguredAuth: vi.fn(() => true),
    },
  };
  // SAFETY: Advisor command tests exercise only the command-context members implemented here.
  return fixture as typeof fixture & ExtensionCommandContext;
}

describe("Advisor commands", () => {
  it("completes the canonical review argument", () => {
    expect(completeAdvisorCommandArguments("rev")?.map(({ value }) => value)).toEqual(["review"]);
  });

  it.effect("retains the command snapshot after the dashboard modal yields", () =>
    Effect.gen(function* () {
      const value = harness();
      const ctx = context();
      const modalReached = deferred<void>();
      const selection = deferred<string>();
      ctx.ui.select.mockImplementationOnce(() => {
        modalReached.resolve(undefined);
        return selection.promise;
      });
      const command = yield* value
        .handler("", ctx)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => modalReached.promise);
      value.setConfig(
        normalizeAdvisorConfig(
          { enabled: true, provider: "other", model: "new", setupDismissed: true },
          "/changed",
        ),
      );
      selection.resolve("Turn off");
      yield* Fiber.join(command);
      expect(value.persist).toHaveBeenCalledWith({ enabled: false }, "/config");
    }),
  );

  it.effect("one-off review remains available while automatic operation is off", () =>
    Effect.gen(function* () {
      const value = harness(
        normalizeAdvisorConfig(
          { enabled: false, provider: "p", model: "m", setupDismissed: true },
          "/config",
        ),
      );
      const ctx = context();
      yield* value.handler("review", ctx);
      expect(value.actions.reviewLast).toHaveBeenCalledWith(ctx);
    }),
  );

  it.effect("rejects removed aliases rather than accepting them", () =>
    Effect.gen(function* () {
      const value = harness();
      const ctx = context();
      for (const removed of [
        "next",
        "pause",
        "resume",
        "enable",
        "disable",
        "settings",
        "status",
        "debug",
        "once",
        "review-last",
        "verify-last",
      ]) {
        yield* value.handler(removed, ctx);
      }
      expect(ctx.ui.notify).toHaveBeenCalledTimes(11);
      expect(value.actions.reviewLast).not.toHaveBeenCalled();
    }),
  );

  it.effect("on and off directly control automatic Advisor operation", () =>
    Effect.gen(function* () {
      const value = harness();
      const ctx = context();
      yield* value.handler("off", ctx);
      expect(value.getConfig().enabled).toBe(false);
      yield* value.handler("on", ctx);
      expect(value.getConfig().enabled).toBe(true);
    }),
  );

  it.effect("setup model choice atomically enables and dismisses onboarding", () =>
    Effect.gen(function* () {
      const value = harness(normalizeAdvisorConfig({}, "/config"));
      const ctx = context({
        selections: ["provider/model"],
        models: [{ provider: "provider", id: "model" }],
      });
      yield* value.handler("setup", ctx);
      expect(value.persist).toHaveBeenCalledOnce();
      expect(value.persist.mock.calls[0]?.[0]).toEqual({
        provider: "provider",
        model: "model",
        enabled: true,
        setupDismissed: true,
      });
      expect(value.getConfig()).toMatchObject({
        provider: "provider",
        model: "model",
        enabled: true,
        setupDismissed: true,
      });
    }),
  );

  it.effect("Not now persists only setup dismissal", () =>
    Effect.gen(function* () {
      const value = harness(normalizeAdvisorConfig({}, "/config"));
      yield* value.handler("setup", context({ selections: ["Not now"] }));
      expect(value.persist).toHaveBeenCalledWith({ setupDismissed: true }, "/config");
      expect(value.getConfig()).toMatchObject({
        enabled: false,
        setupDismissed: true,
        configured: false,
      });
    }),
  );

  it.effect("usage emits one informational session summary", () =>
    Effect.gen(function* () {
      const value = harness(undefined, {
        metrics: {
          ...emptyAdvisorSessionMetrics(),
          cards: 3,
          corrections: 2,
          cost: 0.125,
          latestDurationMs: 250,
          modelResponses: 4,
          settledReviews: 3,
          totalDurationMs: 1_500,
          totalTokens: 12_345,
        },
      });
      const ctx = context();
      yield* value.handler("usage", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledOnce();
      expect(ctx.ui.notify.mock.calls[0]?.[0]).toEqual(expect.stringMatching(/\S/));
      expect(ctx.ui.notify.mock.calls[0]?.[1]).toBe("info");
    }),
  );
});
