import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ConfigRepository, configRepositoryTestLayer } from "../src/config-repository.ts";
import { advisorPlatformLayer, standaloneAdvisorExecutor } from "../src/boundary/executor.ts";
import { FailureLogger, failureLoggerTestLayer } from "../src/failure-logger.ts";
import { HostNotifier, hostNotifierTestLayer } from "../src/host-notifier.ts";
import { normalizeAdvisorConfig } from "../src/config.ts";

it.effect("converts the Promise config seam into a typed repository test Layer", () => {
  const paths: string[] = [];
  const layer = configRepositoryTestLayer((path) => {
    paths.push(path ?? "");
    return normalizeAdvisorConfig({ provider: "p", model: "m" }, path);
  }).pipe(Layer.provideMerge(advisorPlatformLayer));
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const repository = Context.get(context, ConfigRepository);
      const loaded = yield* repository.load("/tmp/advisor.json");
      expect(paths).toEqual(["/tmp/advisor.json"]);
      expect(loaded).toMatchObject({ provider: "p", model: "m", configured: true });
    }),
  );
});

it.effect("awaits the Promise logging seam instead of detaching it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* Deferred.make<string | undefined>();
      const layer = failureLoggerTestLayer(() =>
        standaloneAdvisorExecutor.run(Deferred.await(pending)),
      );
      const context = yield* Layer.build(layer);
      const logger = Context.get(context, FailureLogger);
      let finished = false;
      const logging = logger
        .log("/tmp/advisor.json", {
          contextChars: 1,
          durationMs: 2,
          error: "expected",
          timeoutMs: 3,
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finished = true;
            }),
          ),
        );
      const fiber = yield* logging.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(finished).toBe(false);
      yield* Deferred.succeed(pending, "/tmp/pi-advisor.jsonl");
      expect(yield* Fiber.join(fiber)).toBe("/tmp/pi-advisor.jsonl");
      expect(finished).toBe(true);
    }),
  ),
);

it.effect("isolates hostile host notification callbacks in the service Layer", () => {
  const layer = hostNotifierTestLayer(() => {
    throw new Error("host unavailable");
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const notifier = Context.get(context, HostNotifier);
      expect(() => notifier.notify({} as never, "bounded diagnostic", "warning")).not.toThrow();
    }),
  );
});
