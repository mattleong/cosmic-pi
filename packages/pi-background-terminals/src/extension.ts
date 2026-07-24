/** Thin Pi registration adapter for Background Terminals. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBackgroundTerminalsApplication } from "./application.ts";

export default function backgroundTerminals(pi: ExtensionAPI): void {
  registerBackgroundTerminalsApplication(pi);
}
