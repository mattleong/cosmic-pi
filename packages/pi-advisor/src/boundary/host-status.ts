import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Narrow no-throw Pi status boundary used by lifecycle status orchestration. */
export const setAdvisorStatusAtHostBoundary = (
  ctx: Pick<ExtensionContext, "ui">,
  key: string,
  text: string | undefined,
): boolean => {
  try {
    ctx.ui.setStatus(key, text);
    return true;
  } catch {
    // Status rendering cannot prevent resource cleanup.
    return false;
  }
};

export const advisorStatusIsAnimatedAtHostBoundary = (
  ctx: Pick<ExtensionContext, "mode">,
): boolean => {
  try {
    return ctx.mode === "tui";
  } catch {
    return false;
  }
};

export type AdvisorStatusEffortResult =
  | { readonly ok: true; readonly value: Parameters<typeof clampThinkingLevel>[1] }
  | { readonly ok: false };

export const resolveAdvisorStatusEffortAtHostBoundary = (
  ctx: Pick<ExtensionContext, "modelRegistry">,
  provider: string | undefined,
  modelId: string | undefined,
  thinkingLevel: Parameters<typeof clampThinkingLevel>[1],
): AdvisorStatusEffortResult => {
  try {
    const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
    return {
      ok: true,
      value: model ? clampThinkingLevel(model, thinkingLevel) : thinkingLevel,
    };
  } catch {
    return { ok: false };
  }
};
