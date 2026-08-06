import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerdrForkApplication } from "./application.ts";

export default function herdrFork(pi: ExtensionAPI): void {
  registerHerdrForkApplication(pi);
}
