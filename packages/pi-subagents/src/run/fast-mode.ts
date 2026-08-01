import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import type { SubagentRuntime } from "./model.ts";

export const SUBAGENT_FAST_SERVICE_TIER = FAST_SERVICE_TIER;
export const supportsSubagentFastModel = supportsFastModel;

const splitPiModel = (
  selector: string,
): { readonly provider: string; readonly model: string } | undefined => {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash >= selector.length - 1) return undefined;
  return { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
};

/** Shared package policy for routes that can request OpenAI priority service. */
export const supportsSubagentFastMode = (runtime: SubagentRuntime, model: string): boolean => {
  // Codex is OpenAI-only and validates model-specific priority-tier support through its native
  // catalog and thread/start confirmation. Static config decoding must not reject newly advertised
  // Codex models before that authenticated discovery can run.
  if (runtime === "codex") return model.length > 0;
  if (runtime !== "pi") return false;
  const selected = splitPiModel(model);
  return selected ? supportsFastModel(selected.provider, selected.model) : false;
};
