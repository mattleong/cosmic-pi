import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import { settingsHintRenderer, VimSettingsAdapter } from "pi-cosmic-ui/manager/keybindings";
import { createCodePreviewSettingsList } from "./panel";

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("code-preview-settings", {
    description: "Configure code preview settings",
    handler: (_args, ctx) => {
      if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
        if (ctx.hasUI)
          ctx.ui.notify("Code preview settings require interactive TUI mode.", "warning");
        return Promise.resolve();
      }
      return ctx.ui.custom((tui, theme, keybindings, done) => {
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
          // The shared renderer follows the adapter's focus/search mode instead of assuming
          // a never-searching surface.
          renderHint:
            typeof theme?.fg === "function"
              ? settingsHintRenderer({ dim: (text) => theme.fg("dim", text) })
              : undefined,
        });
      });
    },
  });
}
