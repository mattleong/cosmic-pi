import * as Predicate from "effect/Predicate";

import { getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isProjectTrusted } from "pi-cosmic-core";
import { createSettingsListSurface } from "pi-cosmic-ui/manager/settings-surface";
import { createCodePreviewSettingsModel } from "./panel";

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("code-preview-settings", {
    description: "Configure code preview settings",
    handler: (_args, ctx) => {
      if (ctx.mode !== "tui" || !Predicate.isFunction(ctx.ui.custom)) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Open Pi in an interactive terminal to change code preview settings.",
            "warning",
          );
        return Promise.resolve();
      }
      return ctx.ui.custom((tui, theme, keybindings, done) => {
        const model = createCodePreviewSettingsModel({
          notify: (message, level) => ctx.ui.notify(message, level),
          done: () => done(undefined),
          loadOptions: { projectCwd: ctx.cwd, projectTrusted: isProjectTrusted(ctx) },
        });
        const created = createSettingsListSurface({
          header: new Text(theme.fg("accent", theme.bold("Code Preview Settings")), 1, 1),
          items: model.items,
          height: model.items.length + 2,
          listTheme: getSettingsListTheme(),
          onChange: model.onChange,
          onCancel: model.onCancel,
          matchesKeybinding: Predicate.isFunction(keybindings?.matches)
            ? (data, id) => keybindings.matches(data, id)
            : undefined,
          requestRender: Predicate.isFunction(tui?.requestRender)
            ? () => tui.requestRender()
            : undefined,
          dim: Predicate.isFunction(theme?.fg) ? (text) => theme.fg("dim", text) : (text) => text,
        });
        model.bind(created.list);
        return created.surface;
      });
    },
  });
}
