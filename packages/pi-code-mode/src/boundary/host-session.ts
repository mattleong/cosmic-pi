/**
 * Pure, no-throw Pi session capture helpers, owned by `pi-cosmic-core`.
 *
 * Trust, cwd, and abort-signal reads happen exactly once at the Pi boundary; a hostile
 * context yields an explicit `Unavailable` capture instead of an exception.
 */
export {
  captureHostSignal,
  captureSessionHost,
  isProjectTrusted,
  type CapturedHostSignal,
  type CapturedSessionHost,
} from "pi-cosmic-core";
