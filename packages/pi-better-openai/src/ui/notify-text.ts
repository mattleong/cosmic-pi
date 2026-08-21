/** Pure host-notification formatting shared by command and event catch handlers. */

const MAX_HOST_FAILURE_CHARS = 240;

/**
 * Bounded single-line diagnostic text for host notifications that replace typed
 * failures, so the root cause stays visible without leaking stacks or newlines.
 * Callers pass the typed tagged error their Effect channel rejects with.
 */
export function describeHostFailure(error: { readonly message: string }): string {
  const collapsed = error.message.replace(/\s+/g, " ").trim();
  if (!collapsed) return ":";
  const truncated =
    collapsed.length <= MAX_HOST_FAILURE_CHARS
      ? collapsed
      : `${collapsed.slice(0, MAX_HOST_FAILURE_CHARS)}…`;
  return `: ${truncated}`;
}
