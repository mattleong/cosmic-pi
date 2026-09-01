/** Host-facing definition, registration, and activation controller for `code_mode`. */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { Type } from "typebox";
import { animationFrame, syncProgressTicker } from "../boundary/host-render-ticker.ts";
import { renderCodeModeToolCall, renderCodeModeToolResult } from "../ui/tool-renderer.ts";
import { describeCodeModeCatalog } from "./catalog.ts";
import type { CodeModeToolExecute } from "./execution.ts";
import { MAX_INTENT_LENGTH, truncateDisplay } from "./format.ts";

export const CODE_MODE_TOOL_NAME = "code_mode";

const expandKeys = (): string[] => {
  try {
    const keys: unknown = getKeybindings().getKeys("app.tools.expand");
    return Array.isArray(keys)
      ? keys.slice(0, 4).flatMap((key) => {
          if (!Predicate.isString(key)) return [];
          const bounded = truncateDisplay(sanitizeTerminalLine(key), 32);
          return bounded.length === 0 ? [] : [bounded];
        })
      : [];
  } catch {
    return [];
  }
};

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

const descriptionHeader = (includePowerShell: boolean) =>
  "Run one confined JavaScript program that orchestrates Pi's seven core built-ins " +
  "(tools.pi.read, tools.pi.bash, tools.pi.edit, tools.pi.write, tools.pi.grep, " +
  `tools.pi.find, tools.pi.ls)${includePowerShell ? ", the Windows-only tools.pi.powershell built-in," : ""} ` +
  "and the explicit tools.session.backgroundTask adapter in a single tool call. Sequence, " +
  "transform, filter, branch, and parallelize nested calls, then return only the data you " +
  "need. The tree-walk interpreter itself has no ambient filesystem, network, process, module, " +
  "or timer APIs; authority comes from supplied tools. Shell, edit, write, and background-task " +
  "start operations grant full local-user process, network, environment, and unrestricted " +
  "filesystem authority. Session-configured limits bound interpreter time, call count, and " +
  "model-visible bytes but cannot prevent or undo tool side effects. A started background task " +
  "may outlive the Code Mode call and is owned until Pi session shutdown.\n" +
  "\n" +
  "Nested Pi calls are dispatched directly against fresh built-in definitions. They BYPASS " +
  "Pi tool_call/tool_result middleware, approval and preview extensions, registered tool " +
  "overrides, and session-specific tool operations. The Background Tasks leaf uses only its " +
  "versioned current-session capability and likewise does not dispatch a registered tool. " +
  "Nested shells use Pi's default local implementations. Paths may be relative, absolute, or " +
  "home-relative; code_mode does not confine tool effects to the project directory.";

export interface CodeModeToolDefinitionInput {
  /** Discovery catalog budget (estimated tokens) captured at registration time. */
  readonly catalogBudget: number;
  /** Whether this registration includes Pi's native Windows PowerShell definition. */
  readonly includePowerShell: boolean;
  readonly execute: CodeModeToolExecute;
  /** Test seam for the host-render ticker; production uses the shared Cosmic UI boundary. */
  readonly startUiTicker?: ((intervalMs: number, tick: () => void) => () => void) | undefined;
}

export function buildCodeModeToolDefinition(input: CodeModeToolDefinitionInput) {
  const capturedExpandKeys = expandKeys();
  return defineTool({
    name: CODE_MODE_TOOL_NAME,
    label: "Code Mode",
    description: `${descriptionHeader(input.includePowerShell)}\n\n${describeCodeModeCatalog(
      input.catalogBudget,
      {
        includePowerShell: input.includePowerShell,
      },
    )}`,
    promptSnippet:
      "Run one confined script that orchestrates Pi built-ins and session background tasks",
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
    renderResult: (result, options, theme, context) => {
      const rendered = renderCodeModeToolResult(
        result,
        options,
        theme,
        context,
        animationFrame(),
        capturedExpandKeys,
      );
      syncProgressTicker(rendered.shouldAnimate, context, input.startUiTicker ?? startHostUiTicker);
      return rendered.component;
    },
  });
}
export type CodeModeToolDefinition = ReturnType<typeof buildCodeModeToolDefinition>;

export function registerCodeModeTool(
  pi: ExtensionAPI,
  definition: CodeModeToolDefinition,
): boolean {
  try {
    pi.registerTool(definition);
    return true;
  } catch {
    reconcileCodeModeToolActivation(pi, false);
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
    if (desiredActive && !active.includes(CODE_MODE_TOOL_NAME)) {
      pi.setActiveTools([...active, CODE_MODE_TOOL_NAME]);
    } else if (!desiredActive && active.includes(CODE_MODE_TOOL_NAME)) {
      pi.setActiveTools(active.filter((name) => name !== CODE_MODE_TOOL_NAME));
    }
    return desiredActive;
  } catch {
    return observeCodeModeToolActive(pi);
  }
}

export function observeCodeModeToolActive(pi: ExtensionAPI): boolean {
  try {
    return pi.getActiveTools().includes(CODE_MODE_TOOL_NAME);
  } catch {
    return false;
  }
}
