import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// No model calls: handled inputs disappear and transformed inputs remain queued.
export default function rpcInputFixture(pi: ExtensionAPI) {
  pi.on("input", (event) => {
    if (event.text === "handled") return { action: "handled" };
    return {
      action: "transform",
      text: `${event.source}:${event.streamingBehavior}:${event.text}`,
    };
  });
  pi.registerCommand("fixture-shutdown", {
    description: "Stop the offline RPC fixture",
    handler: (_args, ctx) => {
      ctx.shutdown();
      return Promise.resolve();
    },
  });
}
