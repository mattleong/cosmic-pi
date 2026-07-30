/** Thin Pi registration adapter for pi-herdr. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerdrApplication } from "./application.ts";

export default function herdrExtension(pi: ExtensionAPI): void {
  registerHerdrApplication(pi);
}
