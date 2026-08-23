// Promise-shaped Pi setup UI is an explicit host boundary.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AdvisorOnboardingChoice =
  | { readonly type: "model"; readonly provider: string; readonly model: string }
  | { readonly type: "not-now" };

type AdvisorOnboardingContext = Pick<ExtensionContext, "mode" | "modelRegistry" | "ui">;

/** Pi-owned model discovery and setup UI stay behind one host boundary. */
export function selectAdvisorOnboardingAtHostBoundary(
  ctx: AdvisorOnboardingContext,
): Promise<AdvisorOnboardingChoice | undefined> {
  if (ctx.mode !== "tui") return Promise.resolve(undefined);
  const models = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({ label: `${model.provider}/${model.id}`, model }))
    .sort((left, right) => left.label.localeCompare(right.label));
  if (models.length === 0)
    ctx.ui.notify(
      "No authenticated models are available. Configure a provider in pi, then run /advisor setup.",
      "warning",
    );
  return ctx.ui
    .select("Set up Advisor", [...models.map(({ label }) => label), "Not now"])
    .then((selected) => {
      if (!selected) return undefined;
      if (selected === "Not now") return { type: "not-now" } as const;
      const model = models.find(({ label }) => label === selected)?.model;
      return model
        ? ({ type: "model", provider: model.provider, model: model.id } as const)
        : undefined;
    });
}
