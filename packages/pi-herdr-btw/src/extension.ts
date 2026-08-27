import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerdrBtwApplication } from "./application.ts";

export default function herdrBtw(pi: ExtensionAPI): void {
  registerHerdrBtwApplication(pi);
}
