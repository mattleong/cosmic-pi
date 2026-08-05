import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskUserDialogBridge } from "./host-ui.ts";

export function registerAskUserCommands(pi: ExtensionAPI, bridge: AskUserDialogBridge): void {
  pi.registerCommand("ask-user", {
    description: "Resume the active hidden questionnaire",
    handler: (_args, ctx) => {
      if (!bridge.resume()) ctx.ui.notify("No hidden questionnaire is active.", "info");
      return Promise.resolve();
    },
  });
}
