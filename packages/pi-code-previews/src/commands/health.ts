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
import type { CodePreviewEditableSettingId } from "../config/schema";
import { codePreviewSettings, codePreviewSettingsProblems } from "../config/state";
import { formatOnOff, formatSettingValue } from "../config/values";
import { describeSettingsProblem, getSettingsPath } from "../config/store";
import { SETTING_ITEM_DEFINITIONS } from "../settings/ui/registry";
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

/** One row per tool, noting configuration that applies only after a reload. */
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

/** A setting's health row, named and valued as its settings row is. */
const settingLine = (id: CodePreviewEditableSettingId, note?: string): string =>
  `  ${SETTING_ITEM_DEFINITIONS[id].label}: ${formatSettingValue(codePreviewSettings, id)}${note === undefined ? "" : ` · ${note}`}`;

const OUTPUT_PREVIEW_SETTINGS = [
  "readContentPreview",
  "writeContentPreview",
  "editDiffPreview",
  "grepResultPreview",
  "findResultPreview",
  "lsResultPreview",
  "bashResultPreview",
  "wordEmphasis",
] as const satisfies readonly CodePreviewEditableSettingId[];

function healthLines(cwd: string): string[] {
  const status = getShikiStatus();
  return [
    "Code Previews health",
    "Syntax highlighting",
    settingLine("syntaxHighlighting"),
    settingLine("shikiTheme"),
    `  Highlighter: ${status.initialized ? "ready" : "not started"}`,
    `  Languages: ${status.loadedLanguages} loaded · ${status.pendingLanguages} pending`,
    `  Cache: ${status.cacheSize} of ${countLabel(status.cacheLimit, "entry", "entries")}`,
    `  Size limit: ${countLabel(status.maxHighlightChars, "character")} per preview`,
    "Tool rows",
    settingLine("toolCallCollapsedStyle", RELOAD),
    settingLine("toolCallBackground", RELOAD),
    settingLine("toolCallTiming"),
    settingLine("pathIcons"),
    // Named as the settings group is; expanded rows always show full content.
    "Output previews",
    ...Arr.map(OUTPUT_PREVIEW_SETTINGS, (id) => settingLine(id)),
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
