import * as Effect from "effect/Effect";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../session-capability";
import { CodePreviewSyntaxService } from "./service";

export const initializeShikiEffect = Effect.fn("CodePreviewShiki.initializeFacade")(function* (
  theme: string,
) {
  const service = yield* CodePreviewSyntaxService;
  yield* service.initialize(theme);
});

export function initializeShiki(theme: string): Promise<void> {
  if (!hasCodePreviewSessionCapability()) return Promise.resolve();
  return runCodePreviewSessionEffect(initializeShikiEffect(theme));
}

export const disposeShikiEffect = CodePreviewSyntaxService.use((service) => service.dispose);

// Compatibility facade. Synchronous render entrypoints import `./render` directly so they cannot
// acquire an Effect runtime, Layer, Ref, or mutable service.
export * from "./render";
