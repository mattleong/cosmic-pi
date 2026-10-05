import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { CodePreviewRendererPresentation } from "../../application/renderer-contract";
import { capturePreviewHostTools } from "../../boundary/host-tool-renderers";
import { CORE_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "../names";
import { admitsPreviewSource } from "../preview-admission";
import { getEnabledCodePreviewTools } from "../selection";
import { setCodePreviewToolStatus } from "../status";
import { createBashPreviewTool } from "./bash";
import { createEditPreviewTool } from "./edit";
import { createFindPreviewTool } from "./find";
import { createGrepPreviewTool } from "./grep";
import { createLsPreviewTool } from "./ls";
import { createReadPreviewTool } from "./read";
import { createWritePreviewRenderers, createWritePreviewTool } from "./write";

const RENDERER_FACTORIES = {
  bash: createBashPreviewTool,
  read: createReadPreviewTool,
  write: createWritePreviewRenderers,
  edit: createEditPreviewTool,
  grep: createGrepPreviewTool,
  find: createFindPreviewTool,
  ls: createLsPreviewTool,
} satisfies Record<
  (typeof CORE_CODE_PREVIEW_TOOLS)[number],
  (cwd: string, session: CodePreviewRendererPresentation) => ToolRenderers
>;

/** Construct presentation only; lifecycle owns public source admission and routing. */
export function createBuiltinPreviewRenderers(
  name: string,
  session: CodePreviewRendererPresentation,
): ToolRenderers | undefined {
  const coreName = CORE_CODE_PREVIEW_TOOLS.find((candidate) => candidate === name);
  if (!coreName) return undefined;
  const enabled = session.enabledTools
    ? session.enabledTools.includes(coreName)
    : getEnabledCodePreviewTools().has(coreName);
  if (!enabled) return undefined;
  return RENDERER_FACTORIES[coreName](session.cwd, session);
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
