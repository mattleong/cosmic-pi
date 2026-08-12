/**
 * Guarded Pi `onUpdate` progress boundary for the `code_mode` tool.
 *
 * The host callback may be undefined, may throw synchronously, or may return a rejecting
 * thenable; none of those can break, hang, or fail an execution. Publications stop
 * permanently once the execution settles or the owning session stops being current, so no
 * stale progress ever reaches a replaced session.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { CodeModeToolDetails } from "../tools/format.ts";

export interface GuardedToolUpdatePublisher {
  readonly publish: (partial: AgentToolResult<CodeModeToolDetails>) => void;
  /** Idempotent; after this no further update can be delivered. */
  readonly settle: () => void;
}

export const makeGuardedToolUpdatePublisher = (
  onUpdate: AgentToolUpdateCallback<CodeModeToolDetails> | undefined,
  isCurrent: () => boolean,
): GuardedToolUpdatePublisher => {
  let settled = false;
  return {
    publish: (partial) => {
      if (settled || onUpdate === undefined) return;
      let current = false;
      try {
        current = isCurrent();
      } catch {
        return;
      }
      if (!current) return;
      try {
        const outcome = onUpdate(partial) as unknown;
        if (
          outcome !== null &&
          (typeof outcome === "object" || typeof outcome === "function") &&
          typeof (outcome as { then?: unknown }).then === "function"
        ) {
          // A hostile thenable's rejection (or a throwing `then` getter/implementation)
          // is absorbed by promise assimilation; it never surfaces synchronously here.
          void Promise.resolve(outcome).then(
            () => undefined,
            () => undefined,
          );
        }
      } catch {
        // A synchronously throwing host callback never breaks the execution.
      }
    },
    settle: () => {
      settled = true;
    },
  };
};
