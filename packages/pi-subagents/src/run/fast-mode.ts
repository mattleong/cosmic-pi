import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import type { SubagentRuntime } from "../domain/routing.ts";
import { supportsProfileFastModeStatically } from "../profiles/model.ts";

export const SUBAGENT_FAST_SERVICE_TIER = FAST_SERVICE_TIER;
export const supportsSubagentFastModel = supportsFastModel;

/** Shared static policy; live parent and Codex catalog checks narrow it at their boundaries. */
export const supportsSubagentFastMode = (runtime: SubagentRuntime, model: string): boolean =>
  supportsProfileFastModeStatically({ runtime, model });
