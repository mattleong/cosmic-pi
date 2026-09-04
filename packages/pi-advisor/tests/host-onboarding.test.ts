import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { selectAdvisorOnboardingAtHostBoundary } from "../src/boundary/host-onboarding.ts";

// SAFETY: The shared model picker uses only these Theme methods.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const context = (options: {
  readonly inputs: ReadonlyArray<string>;
  readonly models?: ReadonlyArray<{ readonly provider: string; readonly id: string }>;
  readonly scoped?: ReadonlyArray<{ readonly provider: string; readonly id: string }>;
}) => {
  const models = [...(options.models ?? [])];
  const scoped = [...(options.scoped ?? [])];
  const custom: ExtensionContext["ui"]["custom"] = (factory) =>
    new Promise((resolve) => {
      const tuiFixture = { terminal: { rows: 14 }, requestRender: vi.fn() };
      // SAFETY: The picker reads only terminal rows and requestRender from this TUI fixture.
      const tui = tuiFixture as never;
      const keybindingsFixture = { matches: () => false, getKeys: () => [] };
      // SAFETY: The picker reads only matches and getKeys from this keybinding fixture.
      const keybindings = keybindingsFixture as never;
      const component = factory(tui, theme, keybindings, resolve);
      Promise.resolve(component).then((ready) => {
        for (const input of options.inputs) ready.handleInput?.(input);
      });
    });
  const fixture = {
    mode: "tui" as const,
    hasUI: true,
    model: models[0],
    scopedModels: scoped.map((model) => ({ model })),
    modelRegistry: { getAvailable: () => models },
    ui: { custom, notify: vi.fn(), select: vi.fn() },
  };
  // SAFETY: This boundary fixture implements exactly the context members read by onboarding.
  return fixture as typeof fixture & ExtensionContext;
};

describe("Advisor model onboarding", () => {
  it.effect("starts scoped and can select from all authenticated models with Tab", () =>
    Effect.gen(function* () {
      const models = [
        { provider: "openai", id: "scoped" },
        { provider: "anthropic", id: "all-only" },
      ];
      const result = yield* selectAdvisorOnboardingAtHostBoundary(
        context({ inputs: ["\t", "k", "\r"], models, scoped: [models[0]!] }),
      );
      expect(result).toEqual({ type: "model", provider: "anthropic", model: "all-only" });
    }),
  );

  it.effect("keeps the explicit Not now action", () =>
    Effect.gen(function* () {
      const result = yield* selectAdvisorOnboardingAtHostBoundary(context({ inputs: ["\r"] }));
      expect(result).toEqual({ type: "not-now" });
    }),
  );

  it.effect("treats Esc as cancellation rather than dismissal", () =>
    Effect.gen(function* () {
      const result = yield* selectAdvisorOnboardingAtHostBoundary(
        context({ inputs: ["\x1b"], models: [{ provider: "openai", id: "model" }] }),
      );
      expect(result).toBeUndefined();
    }),
  );
});
