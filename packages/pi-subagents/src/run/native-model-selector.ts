export const MAX_NATIVE_MODEL_SELECTOR_CHARS = 256;

// Claude advertises exact long-context selectors such as `opus[1m]`. Permit one
// bounded literal suffix without accepting general glob syntax or shell metacharacters.
const SAFE_NATIVE_MODEL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*(?:\[[1-9][0-9]*[kKmM]\])?$/;

/**
 * Shared argv/config safety grammar for runtime-native model selectors.
 * Catalog availability and runtime-specific canonical forms are validated separately.
 */
export const isSafeNativeModelSelector = (selector: string): boolean =>
  selector.length <= MAX_NATIVE_MODEL_SELECTOR_CHARS && SAFE_NATIVE_MODEL_SELECTOR.test(selector);
