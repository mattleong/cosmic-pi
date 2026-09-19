/** Thin Pi registration adapter for Subagents. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentChildProcess } from "./boundary/host-environment.ts";

export default function subagents(pi: ExtensionAPI): void | Promise<void> {
  if (isSubagentChildProcess()) return;
  // Pi awaits this factory promise before dispatching lifecycle events.
  return import("./application/register.ts").then(({ registerSubagentApplication }) => {
    registerSubagentApplication(pi);
  });
}
