import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted } from "pi-cosmic-core";
import { createCodePreviewSettingsList } from "./panel";

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("code-preview-settings", {
    description: "Configure code preview settings",
    handler: (_args, ctx) =>
      ctx.ui.custom((_tui, _theme, _kb, done) =>
        createCodePreviewSettingsList({
          notify: (message, level) => ctx.ui.notify(message, level),
          done: () => done(undefined),
          loadOptions: { projectCwd: ctx.cwd, projectTrusted: isProjectTrusted(ctx) },
        }),
      ),
  });
}
