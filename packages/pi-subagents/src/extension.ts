/** Thin Pi registration adapter for Subagents. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentApplication } from "./application/register.ts";
import { isSubagentChildProcess } from "./boundary/host-environment.ts";

export default function subagents(pi: ExtensionAPI): void {
  if (isSubagentChildProcess()) return;
  registerSubagentApplication(pi);
}
