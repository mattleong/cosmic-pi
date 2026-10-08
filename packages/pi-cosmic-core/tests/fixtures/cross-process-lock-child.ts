import * as Effect from "effect/Effect";
import { CrossProcessLock } from "../../src/platform/cross-process-lock.ts";
import { nodeLockFs } from "../../src/platform/node-builtins.ts";

const [directory, mode = "once"] = process.argv.slice(2);
const hold = Effect.callback<void>((resume) => {
  const receive = (message: string) => {
    if (message === "release") resume(Effect.void);
  };
  process.on("message", receive);
  return Effect.sync(() => process.off("message", receive));
});
if (mode === "death-before-publish" || mode === "write-fault") {
  const rename = nodeLockFs.renameSync;
  nodeLockFs.renameSync = (from, to) => {
    if (mode === "write-fault") throw new Error("Injected candidate write failure");
    if (!String(to).endsWith("/owner.json")) process.kill(process.pid, "SIGKILL");
    return rename(from, to);
  };
}
// Polls the non-waiting door until this process owns the slot or admission fails.
const acquire = CrossProcessLock.use((lock) =>
  Effect.gen(function* () {
    for (;;) {
      const lease = yield* lock.tryAcquire("fixture");
      if (lease !== undefined) return lease;
      yield* Effect.sleep(10);
    }
  }),
);
const program =
  mode === "exit"
    ? Effect.void
    : Effect.gen(function* () {
        const lease = yield* acquire;
        if (mode === "pending") lease.mutationStarted();
        process.send?.("acquired");
        if (mode !== "once") yield* hold;
        yield* Effect.try(() => lease.release());
      }).pipe(Effect.provide(CrossProcessLock.layer({ directory: directory! })));
process.send?.("attempting");
Effect.runPromise(program).then(
  () => {
    process.send?.("finished");
    process.disconnect?.();
  },
  () => {
    process.send?.("recovery-required");
    process.disconnect?.();
  },
);
