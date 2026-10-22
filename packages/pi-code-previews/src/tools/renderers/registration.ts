import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CodePreviewRendererPresentation } from "../../application/renderer-contract";
import { capturePreviewHostTools } from "../../boundary/host-tool-renderers";
import { argumentFailureIssue, isRejectedEmptyCall } from "../argument-failure";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { withCodePreviewRenderers } from "../cooperative-tools";
import type { CORE_CODE_PREVIEW_TOOLS, CodePreviewToolName } from "../names";
import { admitsPreviewSource } from "../preview-admission";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { getEnabledCodePreviewTools } from "../selection";
import { setCodePreviewToolStatus } from "../status";
import { bashPreviewRenderers } from "./bash";
import { editPreviewRenderers } from "./edit";
import { grepPreviewRenderers } from "./grep";
import { pathListPreviewRenderers } from "./path-list";
import { readPreviewRenderers } from "./read";
import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import { renderPreviewError } from "./shared/result-prelude";
import type { PreviewRenderers } from "./shared/types";
import { createWritePreviewTool, writePreviewRenderers } from "./write";

const RENDERER_FACTORIES = {
  bash: bashPreviewRenderers,
  read: readPreviewRenderers,
  write: writePreviewRenderers,
  edit: editPreviewRenderers,
  grep: grepPreviewRenderers,
  find: (cwd) => pathListPreviewRenderers("find", cwd),
  ls: (cwd) => pathListPreviewRenderers("ls", cwd),
} satisfies Record<(typeof CORE_CODE_PREVIEW_TOOLS)[number], (cwd: string) => PreviewRenderers>;

export function createBuiltinPreviewRenderers(
  name: (typeof CORE_CODE_PREVIEW_TOOLS)[number],
  session: CodePreviewRendererPresentation,
): ToolRenderers | undefined {
  if (!session.enabledTools.includes(name)) return undefined;
  return withCodePreviewRenderers(
    { name },
    rejectionAware(name, RENDERER_FACTORIES[name](session.cwd)),
    {
      ...session,
      compactSummary: (input) => createBuiltinCompactSummary(name, input),
      expandedContent: builtinExpandedContent(name, session.cwd),
    },
  );
}

// Pi rejects malformed or mismatched arguments before a tool runs, and malformed JSON reaches
// renderers as `{}`. The shared issue explains the rejection, so previews neither derive a target
// from argument defaults nor present Pi's rejection text as tool output while collapsed. An
// executed `ls {}` keeps its default target.
function rejectionAware(
  name: (typeof CORE_CODE_PREVIEW_TOOLS)[number],
  renderers: PreviewRenderers,
): PreviewRenderers {
  return {
    renderCall: (args, theme, context) =>
      isRejectedEmptyCall(context)
        ? new Text(renderCodePreviewToolTitle(name, theme), 0, 0)
        : renderers.renderCall(args, theme, context),
    renderResult(result, options, theme, context) {
      const text = getTextContent(result.content);
      return context.isError && argumentFailureIssue(text)
        ? renderPreviewError(theme, options.expanded, text)
        : renderers.renderResult(result, options, theme, context);
    },
  };
}

export function registerWritePreviewTool(
  pi: ExtensionAPI,
  cwd: string,
  options: {
    ownedTools?: Set<CodePreviewToolName>;
    installedTools?: Set<CodePreviewToolName>;
  } = {},
): void {
  if (!getEnabledCodePreviewTools().has("write")) return;
  try {
    const host = capturePreviewHostTools(pi);
    const existing = host.tools.get("write");
    if (!existing) {
      setCodePreviewToolStatus("write", { state: "unavailable" });
      return;
    }
    if (!admitsPreviewSource("write", host, options.ownedTools ?? new Set())) {
      setCodePreviewToolStatus("write", { state: "skipped-conflict", owner: existing.sourceInfo });
      return;
    }
    if (options.installedTools?.has("write")) {
      setCodePreviewToolStatus("write", { state: "installed" });
      return;
    }
    const active = pi.getActiveTools().includes("write");
    const definition = createWritePreviewTool(cwd);
    options.ownedTools?.add("write");
    pi.registerTool({ ...definition, defaultActive: active });
    options.installedTools?.add("write");
    setCodePreviewToolStatus("write", { state: "installed" });
  } catch {
    setCodePreviewToolStatus("write", { state: "registration-error" });
  }
}
