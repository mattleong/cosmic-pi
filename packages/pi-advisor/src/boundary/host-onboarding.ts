import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { PiCommandError, selectAtHostCommandBoundary } from "./host-commands.ts";

export type AdvisorOnboardingChoice =
  | { readonly type: "model"; readonly provider: string; readonly model: string }
  | { readonly type: "not-now" };

type AdvisorOnboardingContext = Pick<ExtensionContext, "mode" | "modelRegistry" | "ui">;

/** Pi-owned model discovery and setup UI stay behind one host boundary. */
export function selectAdvisorOnboardingAtHostBoundary(
  ctx: AdvisorOnboardingContext,
): Effect.Effect<AdvisorOnboardingChoice | void, PiCommandError> {
  if (ctx.mode !== "tui") return Effect.void;
  return Effect.try({
    try: () => {
      const models = ctx.modelRegistry
        .getAvailable()
        .map((model) => ({ label: `${model.provider}/${model.id}`, model }))
        .sort((left, right) => left.label.localeCompare(right.label));
      if (models.length === 0)
        ctx.ui.notify(
          "No authenticated models are available. Configure a provider in pi, then run /advisor setup.",
          "warning",
        );
      return models;
    },
    catch: () =>
      new PiCommandError({
        operation: "model discovery",
        message: "Advisor command failed.",
      }),
  }).pipe(
    Effect.flatMap((models) =>
      selectAtHostCommandBoundary(ctx, "Set up Advisor", [
        ...models.map(({ label }) => label),
        "Not now",
      ]).pipe(
        Effect.map((selected) => {
          if (!selected) return undefined;
          if (selected === "Not now") return { type: "not-now" } as const;
          const model = models.find(({ label }) => label === selected)?.model;
          return model
            ? ({ type: "model", provider: model.provider, model: model.id } as const)
            : undefined;
        }),
      ),
    ),
  );
}
