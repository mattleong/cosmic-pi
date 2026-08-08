import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ConfigStore } from "../src/config/store.ts";
import { advisorPlatformLayer } from "../src/boundary/executor.ts";
import { FailureLogger } from "../src/logging/logger.ts";
import { PiCommandAdapter } from "../src/boundary/host-commands.ts";
import { HostNotifier, hostNotifierLayer } from "../src/boundary/host-notifier.ts";
import { normalizeAdvisorConfig } from "../src/config/options.ts";
import { configStoreLayerFromLoad, failureLoggerLayerFromLog } from "./support/layers.ts";

it.effect("composes a typed ConfigStore test Layer without Promise seams", () => {
  const paths: string[] = [];
  const layer = configStoreLayerFromLoad((path) => {
    paths.push(path ?? "");
    return normalizeAdvisorConfig({ provider: "p", model: "m" }, path);
  }).pipe(Layer.provideMerge(advisorPlatformLayer));
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const store = Context.get(context, ConfigStore);
      const loaded = yield* store.load("/tmp/advisor.json");
      expect(paths).toEqual(["/tmp/advisor.json"]);
      expect(loaded).toMatchObject({ provider: "p", model: "m", configured: true });
    }),
  );
});

it.effect("fails a throwing test config load as a typed ConfigStore error", () => {
  const layer = configStoreLayerFromLoad(() => {
    throw new Error("unreadable");
  }).pipe(Layer.provideMerge(advisorPlatformLayer));
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const store = Context.get(context, ConfigStore);
      const failure = yield* store.load("/tmp/advisor.json").pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "AdvisorConfigStoreError", operation: "load" });
    }),
  );
});

it.effect("keeps the failure logger fail-open when the test log callback throws", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layer = failureLoggerLayerFromLog(() => {
        throw new Error("hostile log sink");
      });
      const context = yield* Layer.build(layer);
      const logger = Context.get(context, FailureLogger);
      const logged = yield* logger.log("/tmp/advisor.json", {
        contextChars: 1,
        durationMs: 2,
        error: "expected",
        timeoutMs: 3,
      });
      expect(logged).toBeUndefined();
    }),
  ),
);

it.effect("isolates hostile host notification callbacks in the service Layer", () => {
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(hostNotifierLayer);
      const notifier = Context.get(context, HostNotifier);
      expect(() =>
        notifier.notify(
          {
            ui: {
              notify: () => {
                throw new Error("host unavailable");
              },
            },
          } as never,
          "bounded diagnostic",
          "warning",
        ),
      ).not.toThrow();
    }),
  );
});

it.effect("converts rejected command Promises into bounded typed failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(PiCommandAdapter.layer);
      const adapter = Context.get(context, PiCommandAdapter);
      const error = yield* adapter
        .fromPromise(() => Promise.reject(new Error("sensitive host failure")))
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PiCommandError",
        operation: "handler",
        message: "Advisor command failed.",
      });
    }),
  ),
);
