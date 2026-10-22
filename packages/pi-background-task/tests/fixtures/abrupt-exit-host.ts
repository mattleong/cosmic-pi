import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { provideBuiltLayer } from "pi-cosmic-core";
import { LocalProcess } from "../../src/boundary/local-process.ts";
import { normalizeConfig } from "../../src/config/options.ts";
import { BackgroundTaskConfigStore } from "../../src/config/store.ts";
import { BackgroundTaskService } from "../../src/task/service.ts";

// Starts a real task, then exits the way Pi's crash paths do: without session shutdown.
const layer = BackgroundTaskService.layer().pipe(
  Layer.provide(
    Layer.mergeAll(
      LocalProcess.layer,
      Layer.succeed(BackgroundTaskConfigStore, normalizeConfig()),
      Path.layer,
    ),
  ),
);
const exitRequested = Effect.callback<void>((resume) => {
  const receive = (message: string) => {
    if (message === "exit") resume(Effect.void);
  };
  process.on("message", receive);
  return Effect.sync(() => process.off("message", receive));
});

// Separates slow cold module loading from task failures in a timed-out test's message log.
process.send?.("loaded");

Effect.runFork(
  Effect.gen(function* () {
    const service = yield* BackgroundTaskService;
    const task = yield* service.start({
      command: "sleep 60 & echo ready; wait",
      cwd: process.cwd(),
    });
    yield* service.wait({ id: task.id, until: "output", contains: "ready", waitSeconds: 10 });
    process.send?.(`group:${task.pid ?? 0}`);
    process.send?.("ready");
    yield* exitRequested;
    process.exit(9);
  }).pipe(Effect.scoped, provideBuiltLayer(layer)),
);
