import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { nodeCreateAsyncLocalStorage } from "./node-builtins.ts";

export class NativeContextError extends Schema.TaggedError<NativeContextError>()(
  "NativeContextError",
  { operation: Schema.Literals(["acquire", "run", "release"]) },
) {
  override get message(): string {
    return "Native context is unavailable.";
  }
}

/** Native callback provenance only. A stored value grants no authorization. */
export interface NativeContext<A> {
  /** Invoke a foreign callback unchanged, including Promise returns and thrown errors. */
  readonly run: <B>(value: A, callback: () => B) => B;
  /** Read inherited callback provenance, or undefined outside a run or after scope closure. */
  readonly current: () => A | undefined;
}

/** Own one native async context for foreign callbacks, never an Effect execution context. */
export const makeNativeContext = <A>(): Effect.Effect<
  NativeContext<A>,
  NativeContextError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => ({ storage: nodeCreateAsyncLocalStorage<A>(), active: true }),
      catch: () => new NativeContextError({ operation: "acquire" }),
    }),
    (owned) =>
      Effect.try({
        try: () => {
          // Withdraw reads and run authority even if native cleanup fails.
          owned.active = false;
          owned.storage.disable();
        },
        catch: () => new NativeContextError({ operation: "release" }),
      }).pipe(Effect.ignore), // Cleanup is best effort after irrevocable withdrawal.
  ).pipe(
    Effect.map((owned) => ({
      run: <B>(value: A, callback: () => B): B => {
        if (!owned.active) throw new NativeContextError({ operation: "run" });
        return owned.storage.run(value, callback);
      },
      current: () => (owned.active ? owned.storage.getStore() : undefined),
    })),
  );
