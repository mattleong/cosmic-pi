import type { ExtensionAPI, SourceInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { CodePreviewRendererSession } from "../../application/renderer-contract";
import { CORE_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "../names";
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
  (cwd: string, session: CodePreviewRendererSession) => ToolRenderers
>;

/** Construct presentation only; lifecycle owns public source admission and routing. */
export function createBuiltinPreviewRenderers(
  name: string,
  session: CodePreviewRendererSession,
): ToolRenderers | undefined {
  const coreName = CORE_CODE_PREVIEW_TOOLS.find((candidate) => candidate === name);
  if (!coreName) return undefined;
  const enabled = session.enabledTools
    ? session.enabledTools.includes(coreName)
    : getEnabledCodePreviewTools().has(coreName);
  if (!enabled) return undefined;
  return RENDERER_FACTORIES[coreName](session.cwd, session);
}

function sameSource(left: SourceInfo, right: SourceInfo): boolean {
  return (
    left.source === right.source &&
    left.path === right.path &&
    left.scope === right.scope &&
    left.origin === right.origin
  );
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
    const candidates = pi.getAllTools().filter((tool) => tool.name === "write");
    const existing = candidates.length === 1 ? candidates[0] : undefined;
    if (!existing) {
      setCodePreviewToolStatus("write", { state: "unavailable" });
      return;
    }
    const native =
      existing.sourceInfo.source === "builtin" && existing.sourceInfo.path === "builtin:write";
    let priorOwn = false;
    if (!native && options.ownedTools?.has("write")) {
      const anchors = pi
        .getCommands()
        .filter((command) => command.name === "code-previews" && command.source === "extension");
      const source = anchors.length === 1 ? anchors[0]?.sourceInfo : undefined;
      priorOwn = !!source && source.source !== "builtin" && sameSource(source, existing.sourceInfo);
    }
    if (!native && !priorOwn) {
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
