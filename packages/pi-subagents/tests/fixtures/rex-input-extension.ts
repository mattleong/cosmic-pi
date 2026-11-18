import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rexInputFixture(pi: ExtensionAPI) {
  pi.registerCommand("fixture-command", {
    description: "Record an interactive command invocation",
    handler: (args) => {
      pi.appendEntry("fixture-command", args);
      return Promise.resolve();
    },
  });
  pi.on("input", ({ text, source, streamingBehavior }) => {
    if (text === `handle ${source} ${streamingBehavior ?? "idle"}`) return { action: "handled" };
    return { action: "continue" };
  });
}
