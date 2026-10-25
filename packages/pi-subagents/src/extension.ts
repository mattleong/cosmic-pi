import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentChildProcess } from "pi-cosmic-core/host-environment";

export default function subagents(pi: ExtensionAPI): void | Promise<void> {
  if (isSubagentChildProcess()) return;
  // Import one graph at a time: Pi's jiti loader shares in-flight modules between concurrent
  // imports, so a parallel import can read a shared dependency before its exports exist.
  return import("./application/register.ts").then(({ registerSubagentApplication }) =>
    import("./application/messages.ts").then(({ registerSubagentMessageOrigins }) => {
      registerSubagentMessageOrigins(pi);
      return registerSubagentApplication(pi);
    }),
  );
}
