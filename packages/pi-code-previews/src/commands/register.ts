import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionCommand } from "pi-cosmic-core";
import { codePreviewSettingsSubcommand } from "../settings/controller";
import { healthSubcommand } from "./health";

/** `/code-previews`, with `health` and `settings`; a bare command lists them. */
export function registerCodePreviewsCommand(pi: ExtensionAPI): void {
  registerExtensionCommand(pi, {
    name: "code-previews",
    description: "Code preview health and settings",
    subcommands: [healthSubcommand, codePreviewSettingsSubcommand()],
  });
}
