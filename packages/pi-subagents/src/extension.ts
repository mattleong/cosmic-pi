import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentChildProcess } from "pi-cosmic-core/host-environment";

export default function subagents(pi: ExtensionAPI): void | Promise<void> {
  if (isSubagentChildProcess()) return;
  return Promise.all([
    import("./application/messages.ts"),
    import("./application/register.ts"),
  ]).then(([{ registerSubagentMessageOrigins }, { registerSubagentApplication }]) => {
    registerSubagentMessageOrigins(pi);
    return registerSubagentApplication(pi);
  });
}
