/**
 * The cooperative wall-clock deadline shared by one execution. See confinement.ts for why it
 * complements, rather than replaces, up-front bounds on native operations.
 */
import { type AstNode, InterpreterRuntimeError } from "./model.js";

/**
 * Wall-clock source shared by every `ExecutionDeadline`. Production always uses `Date.now`;
 * tests may install a deterministic clock so deadline expiry inside synchronous native work
 * can be exercised without depending on real machine speed.
 */
let deadlineNow: () => number = Date.now;

/** Test seam: installs a deterministic wall-clock source; pass `undefined` to restore `Date.now`. */
export const setDeadlineClockForTesting = (clock: (() => number) | undefined): void => {
  deadlineNow = clock ?? Date.now;
};

/**
 * Shared wall-clock deadline for one execution. `check` is cheap (one clock read), is
 * called between interpreter steps and around synchronous native operations, and throws the
 * same normalized `TimeoutExceeded` diagnostic the Effect timeout produces. A synchronous
 * native operation that has already started cannot be preempted; the deadline guarantees the
 * overrun is observed and normalized at the next interpreter step instead of racing the
 * (event-loop-starved) Effect timer.
 */
export class ExecutionDeadline {
  private readonly expiresAt: number | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(timeoutMs: number | undefined) {
    this.timeoutMs = timeoutMs;
    this.expiresAt = timeoutMs === undefined ? undefined : deadlineNow() + timeoutMs;
  }

  expired(): boolean {
    return this.expiresAt !== undefined && deadlineNow() > this.expiresAt;
  }

  check(node?: AstNode): void {
    if (this.expired()) {
      const error = new InterpreterRuntimeError(
        `Execution timed out after ${this.timeoutMs}ms.`,
        node,
        "TimeoutExceeded",
      );
      throw this.timeoutMs === undefined ? error : error.withFacts({ timeoutMs: this.timeoutMs });
    }
  }
}
