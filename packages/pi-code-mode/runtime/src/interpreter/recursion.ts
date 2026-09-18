import { type AstNode, InterpreterRuntimeError } from "./model.js";

// Ordinary calls trampoline, but async prefixes and generator resumes immediately
// fork Effect fibers. Keep their synchronous ancestry bounded without changing FIFO
// scheduling. The upstream 10,000-frame policy did not settle a local generator
// overflow probe within 40 seconds; this conservative bound is tested on every path.
export const MAX_GUEST_CALL_DEPTH = 128;

// Internal injection keeps focused interpreter tests small. Hosts cannot configure this
// through CodeMode: production executions always use the fixed default.
export class RecursionBudget {
  readonly limit: number;

  constructor(limit = MAX_GUEST_CALL_DEPTH) {
    this.limit = limit;
  }

  next(depth: number, node?: AstNode): number {
    if (depth >= this.limit)
      throw new InterpreterRuntimeError("Maximum guest call depth exceeded.", node).as(
        "RangeError",
      );
    return depth + 1;
  }
}
