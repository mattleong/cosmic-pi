import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import { VimSettingsAdapter } from "pi-cosmic-ui/manager/keybindings";
import { createCodePreviewSettingsList } from "./panel";

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("code-preview-settings", {
    description: "Configure code preview settings",
    handler: (_args, ctx) =>
      ctx.ui.custom((tui, theme, keybindings, done) => {
        const list = createCodePreviewSettingsList({
          notify: (message, level) => ctx.ui.notify(message, level),
          done: () => done(undefined),
          loadOptions: { projectCwd: ctx.cwd, projectTrusted: isProjectTrusted(ctx) },
        });
        return new VimSettingsAdapter(list, {
          matchesKeybinding:
            typeof keybindings?.matches === "function"
              ? (data, id) => keybindings.matches(data, id)
              : undefined,
          requestRender:
            typeof tui?.requestRender === "function" ? () => tui.requestRender() : undefined,
          renderHint:
            typeof theme?.fg === "function"
              ? () => theme.fg("dim", " NORMAL · j/k move · l select · h/q back ")
              : undefined,
        });
      }),
  });
}
