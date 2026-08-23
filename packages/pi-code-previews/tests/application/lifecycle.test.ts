// Test lifecycle boundary intentionally uses Promise-shaped host callbacks and AbortController.
import * as Predicate from "effect/Predicate";

import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime } from "pi-cosmic-core";
import { afterEach } from "vitest";
import { effectTest, settle, step } from "../support/effect-test";
import { CodePreviewSession } from "../../src/application/service";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import {
  codePreviewExtensionTesting,
  codePreviewsWithDependencies,
  type CodePreviewExtensionDependencies,
} from "../../src/extension";

type Context = {
  cwd: string;
  signal?: AbortSignal;
  isProjectTrusted(): boolean;
  ui: { notify(message: string, level: string): void };
};
type Handler = (event: Readonly<Record<never, never>>, ctx: Context) => void | Promise<void>;

const settings = { ...defaultCodePreviewSettings, syntaxHighlighting: false, tools: [] };
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

function harness(load: (call: number, projectTrusted: boolean) => Effect.Effect<typeof settings>) {
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const runSignals: Array<AbortSignal | undefined> = [];
  const forkSignals: Array<AbortSignal | undefined> = [];
  let acquisitions = 0;
  let releases = 0;
  let calls = 0;
  const piFixture = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  };
  // SAFETY: Lifecycle tests invoke only on from this ExtensionAPI fixture.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const dependencies: CodePreviewExtensionDependencies = {
    registerHealth: () => undefined,
    registerSettings: () => undefined,
    registerRenderers: () => undefined,
    makeRuntime: (runtimePi) => {
      const serviceLayer = Layer.effect(
        CodePreviewSession,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions++;
            return CodePreviewSession.of({
              loadSettings: (_cwd, projectTrusted) => load(calls++, projectTrusted),
              initializeSyntax: () => Effect.void,
            });
          }),
          () => Effect.sync(() => releases++),
        ),
      );
      const runtime = makePiManagedRuntime(
        runtimePi,
        codePreviewExtensionTesting.makeApplicationLayer(serviceLayer),
      );
      return {
        ...runtime,
        run: (effect, signal) => {
          runSignals.push(signal);
          return runtime.run(effect, signal);
        },
        fork: (effect, signal) => {
          forkSignals.push(signal);
          return runtime.fork(effect, signal);
        },
      };
    },
  };
  const context = (signal?: AbortSignal): Context => {
    const base = {
      cwd: "/project",
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notifications.push(message) },
    };
    return signal ? { ...base, signal } : base;
  };
  return {
    pi,
    handlers,
    dependencies,
    context,
    notifications,
    counts: () => ({ acquisitions, releases, calls }),
    signals: () => ({ run: [...runSignals], fork: [...forkSignals] }),
  };
}

effectTest(
  "factory registers lifecycle callbacks synchronously without starting a runtime",
  function* () {
    const h = harness(() => Effect.succeed(settings));
    const registration = codePreviewsWithDependencies(h.pi, h.dependencies);
    assert.equal(h.handlers.has("session_start"), true);
    assert.equal(h.handlers.has("session_shutdown"), true);
    assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, calls: 0 });
    yield* step(() => registration);
  },
);

effectTest("replacement interrupts startup and releases each session exactly once", function* () {
  setCodePreviewSettings(settings);
  let interrupted = 0;
  const firstStarted = Deferred.makeUnsafe<void>();
  const h = harness((call) =>
    call === 0
      ? Effect.sync(() => Deferred.doneUnsafe(firstStarted, Effect.void)).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => interrupted++)),
        )
      : Effect.succeed(settings),
  );
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  const first = h.handlers.get("session_start")?.({}, h.context()) as Promise<void>;
  yield* Deferred.await(firstStarted);
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  const second = h.handlers.get("session_start")?.({}, h.context()) as Promise<void>;
  yield* step(() => second);
  yield* step(() => first);
  assert.equal(interrupted, 1);
  assert.deepEqual(h.counts(), { acquisitions: 2, releases: 1, calls: 2 });
  yield* settle(() => h.handlers.get("session_shutdown")?.({}, h.context()));
  yield* settle(() => h.handlers.get("session_shutdown")?.({}, h.context()));
  assert.equal(h.counts().releases, 2);
});

effectTest("abort interrupts pending startup and awaits its finalizer", function* () {
  setCodePreviewSettings(settings);
  let interrupted = 0;
  const pending = Deferred.makeUnsafe<void>();
  const h = harness(() =>
    Effect.sync(() => Deferred.doneUnsafe(pending, Effect.void)).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => interrupted++)),
    ),
  );
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const controller = new AbortController();
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  const startup = h.handlers.get("session_start")?.(
    {},
    h.context(controller.signal),
  ) as Promise<void>;
  yield* Deferred.await(pending);
  controller.abort();
  yield* step(() => startup);
  assert.equal(interrupted, 1);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, calls: 1 });
});

effectTest("startup failure notifies and releases the acquired runtime", function* () {
  setCodePreviewSettings(settings);
  const h = harness(() => Effect.die("settings failed"));
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  yield* settle(() => h.handlers.get("session_start")?.({}, h.context()));
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, calls: 1 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});

effectTest("throwing project trust callbacks fail closed", function* () {
  const observedTrust: boolean[] = [];
  const h = harness((_call, projectTrusted) => {
    observedTrust.push(projectTrusted);
    return Effect.succeed(settings);
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context();
  context.isProjectTrusted = () => {
    throw new Error("host trust failure");
  };

  yield* settle(() => h.handlers.get("session_start")?.({}, context));

  assert.deepEqual(observedTrust, [false]);
  assert.deepEqual(h.notifications, []);
  yield* settle(() => h.handlers.get("session_shutdown")?.({}, context));
  assert.equal(h.counts().releases, 1);
});

effectTest("throwing project trust getters fail closed", function* () {
  const observedTrust: boolean[] = [];
  const h = harness((_call, projectTrusted) => {
    observedTrust.push(projectTrusted);
    return Effect.succeed(settings);
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context();
  Object.defineProperty(context, "isProjectTrusted", {
    get() {
      throw new Error("host trust getter failure");
    },
  });

  yield* settle(() => h.handlers.get("session_start")?.({}, context));

  assert.deepEqual(observedTrust, [false]);
  assert.deepEqual(h.notifications, []);
  yield* settle(() => h.handlers.get("session_shutdown")?.({}, context));
  assert.equal(h.counts().releases, 1);
});

effectTest("throwing renderer registration becomes a handled startup failure", function* () {
  const h = harness(() => Effect.succeed(settings));
  const dependencies: CodePreviewExtensionDependencies = {
    ...h.dependencies,
    registerRenderers: () => {
      throw new Error("host renderer registration failure");
    },
  };
  yield* step(() => codePreviewsWithDependencies(h.pi, dependencies));

  yield* settle(() => h.handlers.get("session_start")?.({}, h.context()));

  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, calls: 1 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});

for (const property of ["cwd", "signal"] as const) {
  effectTest(`throwing session ${property} getters become handled startup failures`, function* () {
    const h = harness(() => Effect.succeed(settings));
    yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
    const context = h.context();
    Object.defineProperty(context, property, {
      configurable: true,
      get() {
        throw new Error(`host ${property} failure`);
      },
    });

    let startup: void | PromiseLike<void>;
    assert.doesNotThrow(() => {
      startup = h.handlers.get("session_start")?.({}, context);
    });
    yield* settle(() => startup);

    assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, calls: 0 });
    assert.deepEqual(h.notifications, ["Code previews failed to start."]);
  });
}

effectTest("throwing AbortSignal.aborted getters become handled startup failures", function* () {
  const h = harness(() => Effect.succeed(settings));
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context(
    new Proxy(new AbortController().signal, {
      get(signal, property) {
        if (property === "aborted") throw new Error("host aborted failure");
        // SAFETY: The `in` check proves this proxy property belongs to the AbortSignal contract.
        const value = property in signal ? signal[property as keyof AbortSignal] : undefined;
        return Predicate.isFunction(value) ? value.bind(signal) : value;
      },
    }),
  );

  yield* settle(() => h.handlers.get("session_start")?.({}, context));

  assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, calls: 0 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});

effectTest("materializes the session signal once for startup and activation fibers", function* () {
  const syntaxSettings = { ...settings, syntaxHighlighting: true };
  setCodePreviewSettings(syntaxSettings);
  const h = harness(() => Effect.succeed(syntaxSettings));
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context();
  const first = new AbortController().signal;
  const second = new AbortController().signal;
  let signalReads = 0;
  Object.defineProperty(context, "signal", {
    configurable: true,
    get() {
      signalReads++;
      return signalReads === 1 ? first : second;
    },
  });

  yield* settle(() => h.handlers.get("session_start")?.({}, context));

  assert.equal(signalReads, 1);
  assert.equal(h.signals().run[0], first);
  assert.equal(h.signals().fork[0], first);
  assert.deepEqual(h.notifications, []);
  yield* settle(() => h.handlers.get("session_shutdown")?.({}, context));
});
