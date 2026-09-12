import * as Effect from "effect/Effect";
import { CrossProcessLock } from "../../src/platform/cross-process-lock.ts";
import { nodeLockFs, nodeHomeDirectory } from "../../src/platform/node-builtins.ts";

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
const program =
  mode === "home"
    ? Effect.sync(() => process.send?.({ home: nodeHomeDirectory() }))
    : CrossProcessLock.use((lock) =>
        lock.withLock("fixture", (lease) =>
          Effect.gen(function* () {
            if (mode === "pending") lease.mutationStarted();
            process.send?.("acquired");
            if (mode !== "once") yield* hold;
          }),
        ),
      ).pipe(Effect.provide(CrossProcessLock.layer({ directory: directory!, pollMs: 10 })));
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
