import { notifyAtHostBoundary, type ExtensionSubcommand } from "pi-cosmic-core";
import { hasCustomSurface, openCommandSurface } from "pi-cosmic-ui/boundary/host-surface";
import { TextPanelComponent } from "pi-cosmic-ui/manager/panel";
import { codePreviewSettings, codePreviewSettingsProblems } from "../config/state";
import { formatOnOff } from "../config/values";
import { describeSettingsProblem, getSettingsPath } from "../config/store";
import { getShikiStatus } from "../syntax/render";
import { formatEnabledCodePreviewTools } from "../tools/selection";
import {
  formatCodePreviewToolsWithState,
  formatSkippedCodePreviewToolLines,
  isNativeMcpRendererAvailable,
} from "../tools/status";

/** `/code-previews health`: renderer health and the settings in effect. */
export const healthSubcommand: ExtensionSubcommand = {
  name: "health",
  description: "Show code preview renderer health and settings",
  handler: (_args, ctx) => {
    const status = getShikiStatus();
    const skippedLines = formatSkippedCodePreviewToolLines();
    const pendingTools = formatCodePreviewToolsWithState("pending");
    const lines = [
      "Code preview health",
      `Shiki initialized: ${status.initialized ? "yes" : "no"}`,
      `Shiki theme: ${codePreviewSettings.shikiTheme}`,
      `Syntax highlighting: ${formatOnOff(codePreviewSettings.syntaxHighlighting)}`,
      `Tool call background: ${codePreviewSettings.toolCallBackground} · changes require /reload`,
      `Configured collapsed style: ${codePreviewSettings.toolCallCollapsedStyle} · changes require /reload`,
      `Tool call timing: ${formatOnOff(codePreviewSettings.toolCallTiming)}`,
      `Read content preview: ${formatOnOff(codePreviewSettings.readContentPreview)}`,
      `Write content preview: ${formatOnOff(codePreviewSettings.writeContentPreview)}`,
      `Edit diff preview: ${formatOnOff(codePreviewSettings.editDiffPreview)}`,
      `Grep result preview: ${formatOnOff(codePreviewSettings.grepResultPreview)}`,
      `Find result preview: ${formatOnOff(codePreviewSettings.findResultPreview)}`,
      `Ls result preview: ${formatOnOff(codePreviewSettings.lsResultPreview)}`,
      `Bash result preview: ${formatOnOff(codePreviewSettings.bashResultPreview)}`,
      `Word-level diff emphasis: ${codePreviewSettings.wordEmphasis}`,
      `Configured tools: ${formatEnabledCodePreviewTools()} · changes require /reload`,
      `Available renderers: ${formatCodePreviewToolsWithState("installed")}`,
      `Native MCP rendering: ${isNativeMcpRendererAvailable() ? "available" : "unavailable"}`,
      `Write hook errors: ${formatCodePreviewToolsWithState("registration-error")}`,
      `Skipped previews: ${skippedLines.length ? "" : "none"}`,
      ...skippedLines,
      `Disabled by config: ${formatCodePreviewToolsWithState("disabled-by-config")}`,
      `Unavailable tools: ${formatCodePreviewToolsWithState("unavailable")}`,
      ...(pendingTools === "none" ? [] : [`Pending renderers: ${pendingTools}`]),
      `Cache: ${status.cacheSize}/${status.cacheLimit}`,
      `Loaded languages: ${status.loadedLanguages}`,
      `Pending languages: ${status.pendingLanguages}`,
      `Max highlight chars: ${status.maxHighlightChars}`,
      `Path icons: ${codePreviewSettings.pathIcons}`,
      `Settings file: ${getSettingsPath()}`,
      ...codePreviewSettingsProblems.map((problem) => describeSettingsProblem(problem, ctx.cwd)),
    ];
    if (!hasCustomSurface(ctx)) {
      if (ctx.hasUI) notifyAtHostBoundary(ctx, lines.join("\n"), "info");
      return Promise.resolve();
    }
    return openCommandSurface(ctx, {
      placement: "overlay",
      create: ({ theme, finish }) =>
        new TextPanelComponent({
          theme,
          title: lines[0] ?? "Code preview health",
          lines: lines.slice(1),
          done: () => finish(undefined),
          dismiss: "any-key",
        }),
    });
  },
};
