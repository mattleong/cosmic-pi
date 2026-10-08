import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { CodePreviewRendererPresentation } from "../../application/renderer-contract";
import { capturePreviewHostTools } from "../../boundary/host-tool-renderers";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { withCodePreviewRenderers } from "../cooperative-tools";
import type { CORE_CODE_PREVIEW_TOOLS, CodePreviewToolName } from "../names";
import { admitsPreviewSource } from "../preview-admission";
import { getEnabledCodePreviewTools } from "../selection";
import { setCodePreviewToolStatus } from "../status";
import { bashPreviewRenderers } from "./bash";
import { editPreviewRenderers } from "./edit";
import { grepPreviewRenderers } from "./grep";
import { pathListPreviewRenderers } from "./path-list";
import { readPreviewRenderers } from "./read";
import { builtinExpandedContent } from "./shared/builtin-expanded-content";
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

/** Construct presentation only; lifecycle owns public source admission and routing. */
export function createBuiltinPreviewRenderers(
  name: (typeof CORE_CODE_PREVIEW_TOOLS)[number],
  session: CodePreviewRendererPresentation,
): ToolRenderers | undefined {
  if (!session.enabledTools.includes(name)) return undefined;
  return withCodePreviewRenderers({ name }, RENDERER_FACTORIES[name](session.cwd), {
    ...session,
    compactSummary: (input) => createBuiltinCompactSummary(name, input),
    expandedContent: builtinExpandedContent(name, session.cwd),
  });
}

/** Write alone needs an execution hook to capture before-state under Pi's mutation queue. */
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
    // The same admission as rendering: exact builtin write, or a hook this extension owns.
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
    // Capture attempted ownership before mutation: refresh can throw after Pi stores the hook.
    options.ownedTools?.add("write");
    pi.registerTool({ ...definition, defaultActive: active });
    options.installedTools?.add("write");
    setCodePreviewToolStatus("write", { state: "installed" });
  } catch {
    setCodePreviewToolStatus("write", { state: "registration-error" });
  }
}
