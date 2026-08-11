/**
 * Isolates a synchronous Pi host callback from Better xAI rendering; owned by `pi-cosmic-core`.
 *
 * Pi footer, status, and TUI callbacks are foreign code. A throwing callback resolves to the
 * supplied neutral fallback so renderer state stays consistent.
 */
export { invokeHostCallback } from "pi-cosmic-core";
