/** Thin Pi registration adapter for code previews. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodePreviewApplication } from "./application/session-lifecycle";

export function codePreviews(pi: ExtensionAPI): Promise<void> {
  return registerCodePreviewApplication(pi);
}

export {
  codePreviewsWithDependencies,
  codePreviewExtensionTesting,
  type CodePreviewExtensionDependencies,
  type CodePreviewRuntime,
} from "./application/session-lifecycle";
