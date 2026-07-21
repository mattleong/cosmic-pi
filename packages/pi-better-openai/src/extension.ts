/** Thin Pi registration adapter for Better OpenAI. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBetterOpenAIApplication } from "./application.ts";

export default function betterOpenAI(pi: ExtensionAPI): void {
  registerBetterOpenAIApplication(pi);
}

export {
  betterOpenAIWithDependencies,
  type BetterOpenAIExtensionDependencies,
  _test,
} from "./application.ts";
