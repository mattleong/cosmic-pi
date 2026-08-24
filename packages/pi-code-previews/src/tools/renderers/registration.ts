import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getBuiltinToolOptions, type BuiltinToolOptions } from "../builtin-options";
import { ALL_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "../names";
import { getEnabledCodePreviewTools } from "../selection";
import { resetCodePreviewToolStatuses, setCodePreviewToolStatus } from "../status";
import { createBashPreviewTool } from "./bash";
import { createEditPreviewTool } from "./edit";
import { createFindPreviewTool } from "./find";
import { createGrepPreviewTool } from "./grep";
import { createLsPreviewTool } from "./ls";
import { createReadPreviewTool } from "./read";
import { createWritePreviewTool } from "./write";

export interface RegisterToolRenderersOptions {
  ownedTools?: Set<CodePreviewToolName>;
  installedTools?: Set<CodePreviewToolName>;
  toolOptions?: BuiltinToolOptions;
  projectTrusted?: boolean;
}

type ToolInstallerFactory = (
  pi: ExtensionAPI,
  cwd: string,
  options: BuiltinToolOptions,
) => () => void;

const TOOL_INSTALLER_FACTORIES = {
  bash: (pi, cwd, options) => {
    const definition = createBashPreviewTool(cwd, options.bash);
    return () => pi.registerTool(definition);
  },
  read: (pi, cwd, options) => {
    const definition = createReadPreviewTool(cwd, options.read);
    return () => pi.registerTool(definition);
  },
  write: (pi, cwd) => {
    const definition = createWritePreviewTool(cwd);
    return () => pi.registerTool(definition);
  },
  edit: (pi, cwd) => {
    const definition = createEditPreviewTool(cwd);
    return () => pi.registerTool(definition);
  },
  grep: (pi, cwd) => {
    const definition = createGrepPreviewTool(cwd);
    return () => pi.registerTool(definition);
  },
  find: (pi, cwd) => {
    const definition = createFindPreviewTool(cwd);
    return () => pi.registerTool(definition);
  },
  ls: (pi, cwd) => {
    const definition = createLsPreviewTool(cwd);
    return () => pi.registerTool(definition);
  },
} satisfies Record<CodePreviewToolName, ToolInstallerFactory>;

type PlannedTool = {
  readonly name: CodePreviewToolName;
  readonly install: () => void;
};

export function registerToolRenderers(
  pi: ExtensionAPI,
  cwd: string,
  options: RegisterToolRenderersOptions = {},
): void {
  const enabledTools = getEnabledCodePreviewTools();
  resetCodePreviewToolStatuses(enabledTools);
  const existingTools = getExistingToolsByName(pi);
  const toolOptions =
    options.toolOptions ?? getBuiltinToolOptions(cwd, options.projectTrusted ?? false);
  const plan: PlannedTool[] = [];

  for (const name of ALL_CODE_PREVIEW_TOOLS) {
    if (!enabledTools.has(name)) continue;
    if (options.installedTools?.has(name)) {
      setCodePreviewToolStatus(name, { state: "installed" });
      continue;
    }

    const existing = existingTools.get(name);
    if (existing && existing.sourceInfo.source !== "builtin" && !options.ownedTools?.has(name)) {
      setCodePreviewToolStatus(name, { state: "skipped-conflict", owner: existing.sourceInfo });
      continue;
    }

    plan.push({ name, install: TOOL_INSTALLER_FACTORIES[name](pi, cwd, toolOptions) });
  }

  for (const { name, install } of plan) {
    try {
      options.ownedTools?.add(name);
      install();
    } catch {
      setCodePreviewToolStatus(name, { state: "registration-error" });
      continue;
    }
    options.installedTools?.add(name);
    setCodePreviewToolStatus(name, { state: "installed" });
  }
}

function getExistingToolsByName(pi: ExtensionAPI): Map<string, ToolInfo> {
  return new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
}
