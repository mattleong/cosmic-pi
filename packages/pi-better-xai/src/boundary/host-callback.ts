/**
 * Isolates a synchronous Pi host callback from Better xAI rendering.
 *
 * Pi footer, status, and TUI callbacks are foreign code. A throwing callback resolves to the
 * supplied neutral fallback so renderer state stays consistent.
 */
export function invokeHostCallback<A>(callback: () => A, fallback: A): A {
  try {
    return callback();
  } catch {
    return fallback;
  }
}
