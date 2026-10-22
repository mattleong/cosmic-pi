import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { codePreviewSettings } from "../config/state";
import { CodePreviewSyntaxService } from "./service";

/** Prepares the session's highlighter for `theme`, while syntax highlighting is on. */
export function initializeShiki(theme: string): Promise<void> {
  if (!hasCodePreviewSessionCapability() || !codePreviewSettings.syntaxHighlighting)
    return Promise.resolve();
  return runCodePreviewSessionEffect(
    CodePreviewSyntaxService.use((service) => service.initialize(theme)),
  );
}
