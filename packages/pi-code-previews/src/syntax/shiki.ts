import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { CodePreviewSyntaxService } from "./service";

export function initializeShiki(theme: string): Promise<void> {
  if (!hasCodePreviewSessionCapability()) return Promise.resolve();
  return runCodePreviewSessionEffect(
    CodePreviewSyntaxService.use((service) => service.initialize(theme)),
  );
}
