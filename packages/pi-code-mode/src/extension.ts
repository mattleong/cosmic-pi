/** Thin Pi registration adapter for the Code Mode foundation. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeModeApplication } from "./application.ts";

export default function codeMode(pi: ExtensionAPI): void {
  registerCodeModeApplication(pi);
}
