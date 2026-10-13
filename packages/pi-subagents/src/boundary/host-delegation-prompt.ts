import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DelegationMode } from "../config/schema.ts";
import {
  DELEGATION_PROMPT_SECTION,
  delegationPrompt,
  NORMAL_START_GUIDELINE,
} from "../delegation/prompt.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";

/**
 * Applies the root session's delegation mode to each agent run. Pi rebuilds prompt options
 * from the registered tools before every run, so a mode change needs no cleanup. Nested
 * children never register this hook; they keep the default guidance.
 */
export const registerDelegationPrompt = (
  pi: ExtensionAPI,
  currentMode: () => DelegationMode | undefined,
): void => {
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    const mode = currentMode();
    if (
      mode === undefined ||
      mode === "normal" ||
      !options.selectedTools.includes(SUBAGENT_TOOL_NAME.start)
    )
      return undefined;
    const prompt = delegationPrompt(mode);
    const guidelines = options.toolGuidelines[SUBAGENT_TOOL_NAME.start];
    if (guidelines)
      options.toolGuidelines[SUBAGENT_TOOL_NAME.start] = guidelines.map((guideline) =>
        guideline === NORMAL_START_GUIDELINE ? prompt.startGuideline : guideline,
      );
    if (prompt.section) options.sections[DELEGATION_PROMPT_SECTION] = prompt.section;
    return undefined;
  });
};
