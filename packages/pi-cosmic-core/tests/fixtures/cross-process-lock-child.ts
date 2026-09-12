import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CrossProcessLock } from "../../src/platform/cross-process-lock.ts";
import {
  nodeLockFs,
  nodeHomeDirectory,
  nodeLockHash,
  nodePath,
} from "../../src/platform/node-builtins.ts";

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
// Frozen v1 boundary evidence, not a second lock implementation. Its release keeps
// the old nonempty tombstone, while the new reader must use this same public slot.
const oldOwner = Effect.gen(function* () {
  const token = "a".repeat(64);
  const slot = nodePath.join(directory!, nodeLockHash("fixture"));
  nodeLockFs.mkdirSync(slot, { mode: 0o700 });
  nodeLockFs.writeFileSync(
    nodePath.join(slot, "owner.json"),
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
      version: 1,
      token,
      pid: process.pid,
      phase: "quiescent",
    }).pipe(Effect.orDie),
    { mode: 0o600 },
  );
  process.send?.("acquired");
  yield* hold;
  nodeLockFs.renameSync(slot, `${slot}.retired-${token}`);
});
const program =
  mode === "v1-owner"
    ? oldOwner
    : mode === "home"
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
