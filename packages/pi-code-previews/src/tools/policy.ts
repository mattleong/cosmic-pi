import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { CodePreviewSettings } from "../config/schema";
import type { CodePreviewToolName } from "./names";

const PREVIEW_SETTINGS = [
  { setting: "readContentPreview", tool: "read" },
  { setting: "writeContentPreview", tool: "write" },
  { setting: "editDiffPreview", tool: "edit" },
  { setting: "grepResultPreview", tool: "grep", commands: ["grep", "egrep", "fgrep"] },
  { setting: "findResultPreview", tool: "find", commands: ["find"] },
  { setting: "lsResultPreview", tool: "ls", commands: ["ls"] },
] as const;
type PreviewSettings = Pick<
  CodePreviewSettings,
  (typeof PREVIEW_SETTINGS)[number]["setting"] | "bashResultPreview"
>;

export function formatToolsSettingValue(tools: readonly CodePreviewToolName[]): string {
  return tools.length ? Arr.join(tools, ", ") : "none";
}

export function getEffectiveCodePreviewToolSet(
  configuredTools: Iterable<CodePreviewToolName>,
  settings: PreviewSettings,
): Set<CodePreviewToolName> {
  const enabled = new Set(configuredTools);
  for (const { setting, tool } of PREVIEW_SETTINGS) if (!settings[setting]) enabled.add(tool);
  const shellHidden = Arr.some(
    PREVIEW_SETTINGS,
    (entry) => "commands" in entry && !settings[entry.setting],
  );
  if (!settings.bashResultPreview || shellHidden) enabled.add("bash");
  return enabled;
}

export function shouldHideShellResultByCommand(
  shellCommand: string | undefined,
  settings: PreviewSettings,
): boolean {
  if (!settings.bashResultPreview) return true;
  if (!shellCommand) return false;
  const policy = Option.getOrUndefined(
    Arr.findFirst(
      PREVIEW_SETTINGS,
      (entry) =>
        "commands" in entry && Arr.some(entry.commands, (command) => command === shellCommand),
    ),
  );
  return policy ? !settings[policy.setting] : false;
}
