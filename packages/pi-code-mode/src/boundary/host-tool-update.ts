/**
 * Guarded Pi `onUpdate` progress boundary for the `code_mode` tool.
 *
 * The host callback may be undefined, may throw synchronously, or may return a rejecting
 * thenable; none of those can break, hang, or fail an execution. Publications stop
 * permanently once the execution settles or the owning session stops being current, so no
 * stale progress ever reaches a replaced session.
 */
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { synchronousNow } from "./native-clock.ts";
import type { CodeModeToolDetails } from "../tools/format.ts";

/** Pi's TUI renders at most once per 16 ms frame; match that cadence at the host boundary. */
export const CODE_MODE_PROGRESS_FRAME_INTERVAL_MS = 16;

export type HostToolUpdateScheduler = (delayMs: number, callback: () => void) => () => void;

export interface GuardedToolUpdatePublisherOptions {
  /** Test seam for deterministic frame scheduling. */
  readonly schedule?: HostToolUpdateScheduler | undefined;
  /** Test seam for deterministic frame timing. */
  readonly now?: (() => number) | undefined;
}

export interface GuardedToolUpdatePublisher {
  /** Delivers the first snapshot immediately and coalesces later snapshots to the host frame. */
  readonly publish: (partial: AgentToolResult<CodeModeToolDetails>) => void;
  /**
   * Immediately delivers a semantic leading edge (row admission or enriched running state),
   * replacing any older pending snapshot so Pi can include it in its already-scheduled frame.
   */
  readonly publishNow: (partial: AgentToolResult<CodeModeToolDetails>) => void;
  /** Idempotent; flushes the latest pending snapshot, then permanently stops publication. */
  readonly settle: () => void;
}

const scheduleHostToolUpdate: HostToolUpdateScheduler = (delayMs, callback) => {
  const fiber = Effect.runFork(
    Effect.sleep(Duration.millis(Math.max(0, delayMs))).pipe(Effect.andThen(Effect.sync(callback))),
  );
  return () => {
    void Effect.runFork(Fiber.interrupt(fiber));
  };
};

export const makeGuardedToolUpdatePublisher = (
  onUpdate: AgentToolUpdateCallback<CodeModeToolDetails> | undefined,
  isCurrent: () => boolean,
  options: GuardedToolUpdatePublisherOptions = {},
): GuardedToolUpdatePublisher => {
  const now = options.now ?? synchronousNow;
  const schedule = options.schedule ?? scheduleHostToolUpdate;
  let settled = false;
  let lastDeliveredAt: number | undefined;
  let pending: AgentToolResult<CodeModeToolDetails> | undefined;
  let cancelScheduled: (() => void) | undefined;

  const readNow = (): number => {
    try {
      const value = now();
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    } catch {
      return 0;
    }
  };

  // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
  const deliver = (partial: AgentToolResult<CodeModeToolDetails>): void => {
    if (onUpdate === undefined) return;
    let current = false;
    try {
      current = isCurrent();
    } catch {
      return;
    }
    if (!current) return;
    lastDeliveredAt = readNow();
    try {
      // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
      const outcome = onUpdate(partial) as unknown;
      if (
        outcome !== null &&
        (hasObjectRuntimeType(outcome) || Predicate.isFunction(outcome)) &&
        Predicate.isFunction((outcome as { then?: unknown }).then)
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
  };

  const flushPending = (): void => {
    const latest = pending;
    pending = undefined;
    if (latest !== undefined) deliver(latest);
  };

  const cancelPendingFlush = (): void => {
    const cancel = cancelScheduled;
    cancelScheduled = undefined;
    if (cancel === undefined) return;
    try {
      cancel();
    } catch {
      // Timer cleanup is best effort while a newer semantic snapshot supersedes it.
    }
  };

  const schedulePendingFlush = (delayMs: number): void => {
    let fired = false;
    try {
      const cancel = schedule(delayMs, () => {
        fired = true;
        cancelScheduled = undefined;
        if (!settled) flushPending();
      });
      if (!fired) cancelScheduled = cancel;
    } catch {
      // Scheduling is presentation-only. Fall back to immediate delivery rather than losing
      // the newest semantic snapshot or affecting execution.
      cancelScheduled = undefined;
      flushPending();
    }
  };

  return {
    publish: (partial) => {
      if (settled || onUpdate === undefined) return;
      if (lastDeliveredAt === undefined) {
        deliver(partial);
        return;
      }
      pending = partial;
      if (cancelScheduled !== undefined) return;
      const elapsed = Math.max(0, readNow() - lastDeliveredAt);
      if (elapsed >= CODE_MODE_PROGRESS_FRAME_INTERVAL_MS) {
        flushPending();
        return;
      }
      schedulePendingFlush(CODE_MODE_PROGRESS_FRAME_INTERVAL_MS - elapsed);
    },
    publishNow: (partial) => {
      if (settled || onUpdate === undefined) return;
      // The immediate snapshot is newer than any pending status-only update. Cancelling first
      // prevents a stale frame callback from rebuilding the host component after this delivery.
      pending = undefined;
      cancelPendingFlush();
      deliver(partial);
    },
    settle: () => {
      if (settled) return;
      settled = true;
      cancelPendingFlush();
      // Final state must never be stranded behind a frame timer, even for a sub-frame run.
      flushPending();
    },
  };
};
