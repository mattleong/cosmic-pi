// Test lifecycle boundary intentionally uses Promises and AbortController.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/strictEffectProvide:off
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime } from "pi-cosmic-core";
import { afterEach, test } from "vitest";
import { CodePreviewSession } from "../application/session-service";
import { defaultCodePreviewSettings, setCodePreviewSettings } from "../settings";
import {
  codePreviewExtensionTesting,
  codePreviewsWithDependencies,
  type CodePreviewExtensionDependencies,
} from "../extension";

type Context = {
  cwd: string;
  signal?: AbortSignal;
  isProjectTrusted(): boolean;
  ui: { notify(message: string, level: string): void };
};
type Handler = (event: unknown, ctx: Context) => unknown;

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
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
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
  const context = (signal?: AbortSignal): Context => ({
    cwd: "/project",
    ...(signal ? { signal } : {}),
    isProjectTrusted: () => true,
    ui: { notify: (message) => notifications.push(message) },
  });
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

test("factory registers lifecycle callbacks synchronously without starting a runtime", async () => {
  const h = harness(() => Effect.succeed(settings));
  const registration = codePreviewsWithDependencies(h.pi, h.dependencies);
  assert.equal(h.handlers.has("session_start"), true);
  assert.equal(h.handlers.has("session_shutdown"), true);
  assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, calls: 0 });
  await registration;
});

test("replacement interrupts startup and releases each session exactly once", async () => {
  setCodePreviewSettings(settings);
  let started: (() => void) | undefined;
  let interrupted = 0;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = harness((call) =>
    call === 0
      ? Effect.sync(() => started?.()).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => interrupted++)),
        )
      : Effect.succeed(settings),
  );
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  const first = h.handlers.get("session_start")?.({}, h.context()) as Promise<void>;
  await firstStarted;
  const second = h.handlers.get("session_start")?.({}, h.context()) as Promise<void>;
  await second;
  await first;
  assert.equal(interrupted, 1);
  assert.deepEqual(h.counts(), { acquisitions: 2, releases: 1, calls: 2 });
  await h.handlers.get("session_shutdown")?.({}, h.context());
  await h.handlers.get("session_shutdown")?.({}, h.context());
  assert.equal(h.counts().releases, 2);
});

test("abort interrupts pending startup and awaits its finalizer", async () => {
  setCodePreviewSettings(settings);
  let started: (() => void) | undefined;
  let interrupted = 0;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = harness(() =>
    Effect.sync(() => started?.()).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => interrupted++)),
    ),
  );
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  const controller = new AbortController();
  const startup = h.handlers.get("session_start")?.(
    {},
    h.context(controller.signal),
  ) as Promise<void>;
  await pending;
  controller.abort();
  await startup;
  assert.equal(interrupted, 1);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, calls: 1 });
});

test("startup failure notifies and releases the acquired runtime", async () => {
  setCodePreviewSettings(settings);
  const h = harness(() => Effect.die("settings failed"));
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  await h.handlers.get("session_start")?.({}, h.context());
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, calls: 1 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});

test("throwing project trust callbacks fail closed", async () => {
  const observedTrust: boolean[] = [];
  const h = harness((_call, projectTrusted) => {
    observedTrust.push(projectTrusted);
    return Effect.succeed(settings);
  });
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  const context = h.context();
  context.isProjectTrusted = () => {
    throw new Error("host trust failure");
  };

  await h.handlers.get("session_start")?.({}, context);

  assert.deepEqual(observedTrust, [false]);
  assert.deepEqual(h.notifications, []);
  await h.handlers.get("session_shutdown")?.({}, context);
  assert.equal(h.counts().releases, 1);
});

test("throwing project trust getters fail closed", async () => {
  const observedTrust: boolean[] = [];
  const h = harness((_call, projectTrusted) => {
    observedTrust.push(projectTrusted);
    return Effect.succeed(settings);
  });
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  const context = h.context();
  Object.defineProperty(context, "isProjectTrusted", {
    get() {
      throw new Error("host trust getter failure");
    },
  });

  await h.handlers.get("session_start")?.({}, context);

  assert.deepEqual(observedTrust, [false]);
  assert.deepEqual(h.notifications, []);
  await h.handlers.get("session_shutdown")?.({}, context);
  assert.equal(h.counts().releases, 1);
});

test("throwing renderer registration becomes a handled startup failure", async () => {
  const h = harness(() => Effect.succeed(settings));
  const dependencies: CodePreviewExtensionDependencies = {
    ...h.dependencies,
    registerRenderers: () => {
      throw new Error("host renderer registration failure");
    },
  };
  await codePreviewsWithDependencies(h.pi, dependencies);

  await h.handlers.get("session_start")?.({}, h.context());

  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, calls: 1 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});

for (const property of ["cwd", "signal"] as const) {
  test(`throwing session ${property} getters become handled startup failures`, async () => {
    const h = harness(() => Effect.succeed(settings));
    await codePreviewsWithDependencies(h.pi, h.dependencies);
    const context = h.context();
    Object.defineProperty(context, property, {
      configurable: true,
      get() {
        throw new Error(`host ${property} failure`);
      },
    });

    let startup: unknown;
    assert.doesNotThrow(() => {
      startup = h.handlers.get("session_start")?.({}, context);
    });
    await startup;

    assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, calls: 0 });
    assert.deepEqual(h.notifications, ["Code previews failed to start."]);
  });
}

test("throwing AbortSignal.aborted getters become handled startup failures", async () => {
  const h = harness(() => Effect.succeed(settings));
  await codePreviewsWithDependencies(h.pi, h.dependencies);
  const context = h.context(
    new Proxy(new AbortController().signal, {
      get(signal, property) {
        if (property === "aborted") throw new Error("host aborted failure");
        const value = Reflect.get(signal, property, signal);
        return typeof value === "function" ? value.bind(signal) : value;
      },
    }),
  );

  await h.handlers.get("session_start")?.({}, context);

  assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, calls: 0 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});

test("materializes the session signal once for startup and activation fibers", async () => {
  const syntaxSettings = { ...settings, syntaxHighlighting: true };
  setCodePreviewSettings(syntaxSettings);
  const h = harness(() => Effect.succeed(syntaxSettings));
  await codePreviewsWithDependencies(h.pi, h.dependencies);
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

  await h.handlers.get("session_start")?.({}, context);

  assert.equal(signalReads, 1);
  assert.equal(h.signals().run[0], first);
  assert.equal(h.signals().fork[0], first);
  assert.deepEqual(h.notifications, []);
  await h.handlers.get("session_shutdown")?.({}, context);
});
