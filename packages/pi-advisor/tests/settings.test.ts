// Pi command handlers are Promise-shaped test boundaries.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import {
  normalizeAdvisorConfig,
  patchAdvisorConfig,
  type AdvisorConfigPatch,
  type ResolvedAdvisorConfig,
} from "../src/config/options.ts";
import { registerAdvisorCommands } from "../src/settings/controller.ts";
import type { AdvisorCommandActions, AdvisorConfigState } from "../src/settings/types.ts";

function harness(
  initial: ResolvedAdvisorConfig = normalizeAdvisorConfig(
    { enabled: true, provider: "p", model: "m", setupDismissed: true },
    "/config",
  ),
) {
  let config = initial;
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const persist = vi.fn((patch: AdvisorConfigPatch) => {
    const base = { enabled: config.enabled, setupDismissed: config.setupDismissed };
    const withProvider = config.provider ? { ...base, provider: config.provider } : base;
    const patched = config.model ? { ...withProvider, model: config.model } : withProvider;
    const raw = patchAdvisorConfig(patched, patch);
    config = normalizeAdvisorConfig(raw, config.configPath);
    return Promise.resolve(config);
  });
  const state: AdvisorConfigState = {
    get: () => config,
    getMetrics: () => ({
      attempted: 0,
      pass: 0,
      revise: 0,
      failure: 0,
      discarded: 0,
      outcomes: {
        pass: 0,
        findings: 0,
        perspective: 0,
        advice: 0,
        guidance: 0,
        revision: 0,
        recovery: 0,
        suppressed: 0,
        discarded: 0,
        failures: 0,
      },
    }),
    persist,
  };
  const actions: AdvisorCommandActions = {
    cancel: vi.fn(() => false),
    fixLast: vi.fn(() => "unavailable" as const),
    dismissLast: vi.fn(() => "unavailable" as const),
    reviewLast: vi.fn(() => "started" as const),
  };
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  registerAdvisorCommands(
    { registerCommand: (name, definition) => commands.set(name, definition as never) },
    state,
    actions,
  );
  return { commands, actions, persist, getConfig: () => config };
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

const invoke = <ValueInput>(value: ValueInput): Effect.Effect<void> =>
  Effect.promise(() => Promise.resolve(value).then(() => undefined));

describe("Advisor commands", () => {
  it.effect("dashboard shows only contextual core actions", () =>
    Effect.gen(function* () {
      const value = harness();
      const ctx = context();
      yield* invoke(value.commands.get("advisor")?.handler("", ctx));
      expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("Advisor · ready"), [
        "Change model",
        "Turn off",
        "Usage",
        "Done",
      ]);
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
      yield* invoke(value.commands.get("advisor")?.handler("review", ctx));
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
        yield* invoke(value.commands.get("advisor")?.handler(removed, ctx));
      }
      expect(ctx.ui.notify).toHaveBeenCalledTimes(11);
      expect(value.actions.reviewLast).not.toHaveBeenCalled();
    }),
  );

  it.effect("on and off directly control automatic Advisor operation", () =>
    Effect.gen(function* () {
      const value = harness();
      const ctx = context();
      yield* invoke(value.commands.get("advisor")?.handler("off", ctx));
      expect(value.getConfig().enabled).toBe(false);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Advisor is off.", "info");
      yield* invoke(value.commands.get("advisor")?.handler("on", ctx));
      expect(value.getConfig().enabled).toBe(true);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Advisor is on.", "info");
    }),
  );

  it.effect("setup model choice atomically enables and dismisses onboarding", () =>
    Effect.gen(function* () {
      const value = harness(normalizeAdvisorConfig({}, "/config"));
      const ctx = context({
        selections: ["provider/model"],
        models: [{ provider: "provider", id: "model" }],
      });
      yield* invoke(value.commands.get("advisor")?.handler("setup", ctx));
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
      yield* invoke(
        value.commands.get("advisor")?.handler("setup", context({ selections: ["Not now"] })),
      );
      expect(value.persist).toHaveBeenCalledWith({ setupDismissed: true }, "/config");
      expect(value.getConfig()).toMatchObject({
        enabled: false,
        setupDismissed: true,
        configured: false,
      });
    }),
  );

  it.effect("usage remains a concise detailed report", () =>
    Effect.gen(function* () {
      const value = harness();
      const ctx = context();
      yield* invoke(value.commands.get("advisor")?.handler("usage", ctx));
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Responses/reviews/cards:"),
        "info",
      );
    }),
  );
});
