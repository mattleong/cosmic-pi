// Promise-shaped Pi setup UI is an explicit host boundary.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AdvisorOnboardingChoice =
  | { readonly type: "model"; readonly provider: string; readonly model: string }
  | { readonly type: "not-now" };

type AdvisorOnboardingContext = Pick<ExtensionContext, "mode" | "modelRegistry" | "ui">;

/** Pi-owned model discovery and setup UI stay behind one host boundary. */
export async function selectAdvisorOnboardingAtHostBoundary(
  ctx: AdvisorOnboardingContext,
): Promise<AdvisorOnboardingChoice | undefined> {
  if (ctx.mode !== "tui") return undefined;
  const models = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({ label: `${model.provider}/${model.id}`, model }))
    .sort((left, right) => left.label.localeCompare(right.label));
  if (models.length === 0)
    ctx.ui.notify(
      "No authenticated models are available. Configure a provider in pi, then run /advisor setup.",
      "warning",
    );
  const selected = await ctx.ui.select("Set up Advisor", [
    ...models.map(({ label }) => label),
    "Not now",
  ]);
  if (!selected) return undefined;
  if (selected === "Not now") return { type: "not-now" };
  const model = models.find(({ label }) => label === selected)?.model;
  return model ? { type: "model", provider: model.provider, model: model.id } : undefined;
}
