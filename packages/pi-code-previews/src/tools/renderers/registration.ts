import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ToolDefinitionFactory = (cwd: string, options: BuiltinToolOptions) => AnyToolDefinition;

const TOOL_DEFINITION_FACTORIES = {
  bash: (cwd, options) => createBashPreviewTool(cwd, options.bash),
  read: (cwd, options) => createReadPreviewTool(cwd, options.read),
  write: (cwd) => createWritePreviewTool(cwd),
  edit: (cwd) => createEditPreviewTool(cwd),
  grep: (cwd) => createGrepPreviewTool(cwd),
  find: (cwd) => createFindPreviewTool(cwd),
  ls: (cwd) => createLsPreviewTool(cwd),
} satisfies Record<CodePreviewToolName, ToolDefinitionFactory>;

type PlannedTool = {
  readonly name: CodePreviewToolName;
  readonly definition: AnyToolDefinition;
};

export function registerToolRenderers(
  pi: ExtensionAPI,
  cwd: string,
  options: RegisterToolRenderersOptions = {},
): void {
  const enabledTools = getEnabledCodePreviewTools();
  resetCodePreviewToolStatuses(enabledTools);
  const existingTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
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

    plan.push({ name, definition: TOOL_DEFINITION_FACTORIES[name](cwd, toolOptions) });
  }

  for (const { name, definition } of plan) {
    try {
      options.ownedTools?.add(name);
      pi.registerTool(definition);
    } catch {
      setCodePreviewToolStatus(name, { state: "registration-error" });
      continue;
    }
    options.installedTools?.add(name);
    setCodePreviewToolStatus(name, { state: "installed" });
  }
}
