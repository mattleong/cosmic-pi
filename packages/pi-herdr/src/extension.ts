/** Thin Pi registration adapter for pi-herdr. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerdrApplication } from "./application.ts";
import { isSubagentChildProcess } from "./boundary/host-environment.ts";

export default function herdrExtension(pi: ExtensionAPI): void {
  if (isSubagentChildProcess()) return;
  registerHerdrApplication(pi);
}
