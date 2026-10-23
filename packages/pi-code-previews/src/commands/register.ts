import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionCommand } from "pi-cosmic-core/host-command";
import { codePreviewSettingsSubcommand } from "../settings/controller";
import { healthSubcommand } from "./health";

export function registerCodePreviewsCommand(pi: ExtensionAPI): void {
  registerExtensionCommand(pi, {
    name: "code-previews",
    description: "Code preview health and settings",
    subcommands: [healthSubcommand, codePreviewSettingsSubcommand()],
  });
}
