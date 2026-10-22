import * as Effect from "effect/Effect";
import { guardProcessGroupAtHostExit } from "../../src/platform/process-group-exit-guard.ts";
import { nodeSpawn } from "../../src/platform/node-builtins.ts";

// Hosts a detached group, then exits abruptly the way Pi's crash paths do.
const [mode = "guarded"] = process.argv.slice(2);
const group = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
group.unref();
const exitRequested = Effect.callback<void>((resume) => {
  const receive = (message: string) => {
    if (message === "exit") resume(Effect.void);
  };
  process.on("message", receive);
  return Effect.sync(() => process.off("message", receive));
});

Effect.runFork(
  Effect.gen(function* () {
    const guard = yield* guardProcessGroupAtHostExit(group.pid ?? 0);
    if (mode === "released") yield* guard.release;
    process.send?.(`group:${group.pid ?? 0}`);
    process.send?.("ready");
    yield* exitRequested;
    process.exit(9);
  }).pipe(Effect.scoped),
);
