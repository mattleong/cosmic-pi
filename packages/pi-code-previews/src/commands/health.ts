import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import { countLabel } from "pi-cosmic-core/display";
import { nodeDisplayHomeDirectory } from "pi-cosmic-core/platform/node-builtins";
import { abbreviateHomePath } from "pi-cosmic-core/platform/paths";
import { notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import { hasCustomSurface, openCommandSurface } from "pi-cosmic-ui/boundary/host-surface";
import { TextPanelComponent } from "pi-cosmic-ui/manager/panel";
import { wrapNoticeText } from "pi-cosmic-ui/boundary/host-settings-command";
import { codePreviewSettings, codePreviewSettingsProblems } from "../config/state";
import { formatOnOff } from "../config/values";
import { describeSettingsProblem, getSettingsPath } from "../config/store";
import { SETTING_ITEM_DEFINITIONS, type SettingsUiItemId } from "../settings/ui/registry";
import { getShikiStatus } from "../syntax/render";
import { getEnabledCodePreviewTools } from "../tools/selection";
import { ALL_CODE_PREVIEW_TOOLS } from "../tools/names";
import {
  formatToolOwner,
  getCodePreviewToolStatuses,
  isNativeMcpRendererAvailable,
  type CodePreviewToolStatus,
} from "../tools/status";

const RELOAD = "changes apply after /reload";

const toolState = (status: CodePreviewToolStatus | undefined): string =>
  status === undefined
    ? "pending"
    : Match.value(status).pipe(
        Match.when({ state: "installed" }, () => "previewed"),
        Match.when({ state: "pending" }, () => "pending"),
        Match.when({ state: "disabled-by-config" }, () => "off"),
        Match.when({ state: "unavailable" }, () => "tool not available"),
        Match.when({ state: "registration-error" }, () => "write hook failed · retry with /reload"),
        Match.when(
          { state: "skipped-conflict" },
          ({ owner }) => `owned by ${formatToolOwner(owner)}`,
        ),
        Match.exhaustive,
      );

/** One row per tool, noting configuration that takes effect only after a reload. */
function toolRows(): string[] {
  const statuses = getCodePreviewToolStatuses();
  const enabled = getEnabledCodePreviewTools();
  return Arr.map(ALL_CODE_PREVIEW_TOOLS, (tool) => {
    const status = statuses.get(tool);
    const active = status !== undefined && status.state !== "disabled-by-config";
    const pending = enabled.has(tool) !== active && status?.state !== "skipped-conflict";
    return `  ${tool}: ${toolState(status)}${pending ? ` · turns ${formatOnOff(enabled.has(tool))} after /reload` : ""}`;
  });
}

/** A setting's health row, named as its settings row is. */
const settingLine = (id: SettingsUiItemId, value: string, note?: string): string =>
  `  ${SETTING_ITEM_DEFINITIONS[id].label}: ${value}${note === undefined ? "" : ` · ${note}`}`;

function healthLines(cwd: string): string[] {
  const status = getShikiStatus();
  const settings = codePreviewSettings;
  return [
    "Code Previews health",
    "Syntax highlighting",
    settingLine("syntaxHighlighting", formatOnOff(settings.syntaxHighlighting)),
    settingLine("shikiTheme", settings.shikiTheme),
    `  Highlighter: ${status.initialized ? "ready" : "not started"}`,
    `  Languages: ${status.loadedLanguages} loaded · ${status.pendingLanguages} pending`,
    `  Cache: ${status.cacheSize} of ${countLabel(status.cacheLimit, "entry", "entries")}`,
    `  Size limit: ${countLabel(status.maxHighlightChars, "character")} per preview`,
    "Tool rows",
    settingLine("toolCallCollapsedStyle", settings.toolCallCollapsedStyle, RELOAD),
    settingLine("toolCallBackground", settings.toolCallBackground, RELOAD),
    settingLine("toolCallTiming", formatOnOff(settings.toolCallTiming)),
    settingLine("pathIcons", settings.pathIcons),
    // Named as the settings group is; expanded rows always show full content.
    "Output previews",
    settingLine("readContentPreview", formatOnOff(settings.readContentPreview)),
    settingLine("writeContentPreview", formatOnOff(settings.writeContentPreview)),
    settingLine("editDiffPreview", formatOnOff(settings.editDiffPreview)),
    settingLine("grepResultPreview", formatOnOff(settings.grepResultPreview)),
    settingLine("findResultPreview", formatOnOff(settings.findResultPreview)),
    settingLine("lsResultPreview", formatOnOff(settings.lsResultPreview)),
    settingLine("bashResultPreview", formatOnOff(settings.bashResultPreview)),
    settingLine("wordEmphasis", settings.wordEmphasis),
    "Tools",
    ...toolRows(),
    `  MCP calls: ${isNativeMcpRendererAvailable() ? "previewed" : "not available"}`,
    "Settings",
    `  File: ${abbreviateHomePath(getSettingsPath(), nodeDisplayHomeDirectory())}`,
    ...Arr.map(
      codePreviewSettingsProblems,
      (problem) => `  ${describeSettingsProblem(problem, cwd)}`,
    ),
  ];
}

export const healthSubcommand: ExtensionSubcommand = {
  name: "health",
  description: "Show renderer health",
  handler: (_args, ctx) => {
    const lines = healthLines(ctx.cwd);
    if (!hasCustomSurface(ctx)) {
      // A notice doesn't hang its own wraps, so the report wraps within phone width first.
      if (ctx.hasUI) notifyAtHostBoundary(ctx, wrapNoticeText(Arr.join(lines, "\n")), "info");
      return Promise.resolve();
    }
    return openCommandSurface(ctx, {
      placement: "overlay",
      create: ({ theme, finish, getHeight }) =>
        new TextPanelComponent({
          theme,
          title: lines[0] ?? "Code Previews health",
          lines: lines.slice(1),
          done: () => finish(undefined),
          maxHeight: getHeight,
        }),
    });
  },
};
