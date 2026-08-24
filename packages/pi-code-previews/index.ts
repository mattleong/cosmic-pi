/**
 * Syntax-highlighted code previews for pi.
 *
 * The package root is the public API for package authors. Keep extension internals under `src/`
 * and expose only stable helpers/types from this file.
 */
export { codePreviews as default } from "./src/extension";

/** Load persisted code-preview settings into the runtime singleton and return a defensive copy. */
export { loadCodePreviewSettings } from "./src/config/store";

/** Decorate a package-owned tool, capturing the current visual shell mode at wrapping time. */
export { withCodePreviewShell, type CodePreviewShellOptions } from "./src/tools/cooperative-tools";

/** Reuse the canonical standalone-call icon in compound or nested tool renderers. */
export { getCodePreviewToolIcon } from "./src/tools/presentation";

/** Public settings types used by package authors integrating with pi-code-previews. */
export type { CodePreviewSettings, ToolCallBackgroundMode } from "./src/config/schema";
