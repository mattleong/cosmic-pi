import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { confirmProcessGroupExit, guardProcessGroupAtHostExit } from "pi-cosmic-core";
import { ChildProcess } from "../../src/boundary/child-process.ts";
import { nodeSpawn } from "../../src/boundary/node-builtins.ts";
import { detachedDescendantGroups, terminateProcessTree } from "../../src/boundary/process-tree.ts";
import type { ProcessTransportRuntime } from "../../src/boundary/process-transport.ts";
import { backendLaunch } from "./backend-supervisor.ts";

// Starts a subagent child through the real launch boundary, then exits the way Pi's crash paths
// do: without closing scopes. The child keeps the launch's spawn options but runs a shell whose
// group, like a busy child's tools, outlives the host's closed pipes.
const [agentDirectory = ""] = process.argv.slice(2);
const transportRuntime: ProcessTransportRuntime = {
  spawn: (_command, _args, options) => nodeSpawn("/bin/sh", ["-c", "sleep 60 & wait"], options),
  terminate: terminateProcessTree,
  confirmGroupExit: confirmProcessGroupExit,
  detachedGroups: detachedDescendantGroups,
  guardGroup: guardProcessGroupAtHostExit,
};
const exitRequested = Effect.callback<void>((resume) => {
  const receive = (message: string) => {
    if (message === "exit") resume(Effect.void);
  };
  process.on("message", receive);
  return Effect.sync(() => process.off("message", receive));
});

// Separates slow cold module loading from launch failures in a timed-out test's message log.
process.send?.("loaded");

Effect.runFork(
  Effect.gen(function* () {
    const children = yield* ChildProcess;
    const child = yield* children.spawn(backendLaunch({ runId: "abrupt-exit" }));
    process.send?.(`group:${child.pid}`);
    process.send?.("ready");
    yield* exitRequested;
    process.exit(9);
  }).pipe(
    Effect.scoped,
    Effect.provide(ChildProcess.layer({ agentDirectory, transportRuntime })),
    Effect.tapCause((cause) => Effect.sync(() => process.send?.(`failed:${Cause.pretty(cause)}`))),
  ),
);
