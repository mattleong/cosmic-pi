/**
 * Host-facing `code_mode` tool controller: definition assembly, registration, and active-list
 * reconciliation that only ever adds or removes the one extension-owned tool name.
 */
import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderCodeModeToolCall, renderCodeModeToolResult } from "../ui/tool-renderer.ts";
import { describeCodeModeCatalog } from "./catalog.ts";
import type { CodeModeToolExecute } from "./execution.ts";
import { MAX_INTENT_LENGTH } from "./format.ts";

export const CODE_MODE_TOOL_NAME = "code_mode";

const parameters = Type.Object({
  code: Type.String({
    description:
      "Program source for the confined Code Mode interpreter (restricted JavaScript subset).",
  }),
  intent: Type.Optional(
    Type.String({
      maxLength: MAX_INTENT_LENGTH,
      description:
        "Strongly requested: a short human-readable purpose for this program (a few words, " +
        'e.g. "Inspect the extension"), shown in the UI instead of the raw source. It never ' +
        "affects execution.",
    }),
  ),
});

const DESCRIPTION_HEADER =
  "Run one confined JavaScript program that orchestrates all seven Pi built-ins " +
  "(tools.pi.read, tools.pi.bash, tools.pi.edit, tools.pi.write, tools.pi.grep, " +
  "tools.pi.find, tools.pi.ls) in a single tool call: sequence, transform, filter, branch, " +
  "and parallelize nested calls, then return only the data you need. The tree-walk " +
  "interpreter itself has no ambient filesystem, network, process, module, or timer APIs; " +
  "authority comes from supplied tools. In particular, bash/edit/write grant full local-user " +
  "process, network, environment, and unrestricted filesystem authority. Session-configured " +
  "limits bound interpreter time, call count, and model-visible bytes but cannot prevent or " +
  "undo tool side effects.\n" +
  "\n" +
  "Nested Pi calls are dispatched directly against fresh built-in definitions: they BYPASS " +
  "Pi tool_call/tool_result middleware, approval and preview extensions, registered tool " +
  "overrides, and session-specific tool operations. Nested bash therefore uses Pi's default " +
  "local shell implementation rather than any configured or overridden top-level Bash. Paths " +
  "may be relative, absolute, or home-relative; code_mode does not confine tool effects to " +
  "the project directory.";

export interface CodeModeToolDefinitionInput {
  /** Discovery catalog budget (estimated tokens) captured at registration time. */
  readonly catalogBudget: number;
  readonly execute: CodeModeToolExecute;
}

/** Builds the one extension-owned `code_mode` tool definition (unwrapped). */
export function buildCodeModeToolDefinition(input: CodeModeToolDefinitionInput) {
  return defineTool({
    name: CODE_MODE_TOOL_NAME,
    label: "Code Mode",
    description: `${DESCRIPTION_HEADER}\n\n${describeCodeModeCatalog(input.catalogBudget)}`,
    promptSnippet:
      "Run one confined script that orchestrates Pi read/bash/edit/write/grep/find/ls calls",
    promptGuidelines: [
      "Use code_mode when one task needs several dependent or parallel Pi built-in calls whose " +
        "intermediate results you would otherwise echo through the transcript; write one small " +
        "program and return only the distilled result.",
      "Always pass the optional code_mode intent parameter: a short human-readable phrase " +
        'describing what the program is for (e.g. "Inspect the extension"); the UI shows it ' +
        "in place of the raw program source.",
      "Prefer a concise distilled string when structure is unnecessary; otherwise return a " +
        "small object containing only the requested fields, never raw nested tool results or " +
        "whole files.",
    ],
    parameters,
    execute: input.execute,
    renderCall: (args, theme, context) => renderCodeModeToolCall(args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderCodeModeToolResult(result, options, theme, context),
  });
}

// oxlint-disable-next-line no-explicit-any -- Pi's own AnyToolDefinition shape.
export type CodeModeToolDefinition = ToolDefinition<any, any, any>;

/**
 * Removes only `code_mode` from the active tool list, preserving every other active tool
 * exactly. Returns whether the tool was active before removal; a hostile host yields `false`
 * without throwing.
 */
export function deactivateCodeModeTool(pi: ExtensionAPI): boolean {
  try {
    const active = pi.getActiveTools();
    if (!active.includes(CODE_MODE_TOOL_NAME)) return false;
    pi.setActiveTools(active.filter((name) => name !== CODE_MODE_TOOL_NAME));
    return true;
  } catch {
    return false;
  }
}

/**
 * Registers (or re-registers) the wrapped definition. Same-extension re-registration
 * replaces the previous implementation for the same name. Returns `false` (after removing
 * the name from the active list) when the host refuses registration.
 */
export function registerCodeModeTool(
  pi: ExtensionAPI,
  definition: CodeModeToolDefinition,
): boolean {
  try {
    pi.registerTool(definition);
    return true;
  } catch {
    deactivateCodeModeTool(pi);
    return false;
  }
}

/**
 * Reconciles the active list to the desired `code_mode` activation, touching no other name.
 * Registration of a brand-new name auto-activates it while a re-registered name keeps its
 * previous activation; reconciliation makes both paths deterministic. Returns the activation
 * this extension believes is now in effect (observed post hoc when the host misbehaves).
 */
export function reconcileCodeModeToolActivation(pi: ExtensionAPI, desiredActive: boolean): boolean {
  try {
    const active = pi.getActiveTools();
    if (desiredActive) {
      pi.setActiveTools([...new Set([...active, CODE_MODE_TOOL_NAME])]);
    } else if (active.includes(CODE_MODE_TOOL_NAME)) {
      pi.setActiveTools(active.filter((name) => name !== CODE_MODE_TOOL_NAME));
    }
    return desiredActive;
  } catch {
    return observeCodeModeToolActive(pi);
  }
}

/**
 * True when the user (or another surface) deliberately deactivated `code_mode` after this
 * extension last left it active. Observed at session boundaries before this extension
 * touches the active list, so lifecycle removals are never misread as user intent.
 */
export function observeCodeModeToolActive(pi: ExtensionAPI): boolean {
  try {
    return pi.getActiveTools().includes(CODE_MODE_TOOL_NAME);
  } catch {
    return false;
  }
}
