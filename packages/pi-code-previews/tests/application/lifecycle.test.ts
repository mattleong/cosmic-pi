// Test lifecycle boundary intentionally uses Promise-shaped host callbacks and AbortController.
import assert from "node:assert/strict";
import {
  withFileMutationQueue,
  type ExtensionAPI,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime, nodeFilePlatformLayer, provideBuiltLayer } from "pi-cosmic-core";
import { makeLifecycleProbe } from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import {
  captureCodePreviewSessionCapability,
  clearCodePreviewSessionCapability,
  hasCodePreviewSessionCapability,
} from "../../src/application/capability";
import {
  codePreviewsWithDependencies,
  type CodePreviewExtensionDependencies,
} from "../../src/application/lifecycle";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { codePreviewApplicationLayer } from "../../src/layer";
import { registerToolRenderers } from "../../src/tools/renderers/registration";
import { effectTest, settle, step } from "../support/effect-test";
import {
  executeWriteWithPreview,
  executeWriteWithPreviewEffect,
} from "../../src/write/preview-execution";
import { lookupBeforeWrite } from "../../src/write/projection";

for (const cancellation of ["abort", "replacement", "shutdown"] as const) {
  it.effect(`revokes a queued write on ${cancellation} before its predecessor releases`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "preview-queue-" });
      const path = `${directory}/target.txt`;
      yield* fs.writeFileString(path, "before");
      const h = harness();
      yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
      yield* step(() => start(h));
      const predecessorEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runPredecessor = Effect.runPromiseWith(yield* Effect.context<never>());
      const predecessor = withFileMutationQueue(path, () =>
        runPredecessor(
          Deferred.succeed(predecessorEntered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(release, undefined);
          yield* step(() => predecessor);
          yield* step(() => shutdown(h));
        }),
      );
      yield* Deferred.await(predecessorEntered);
      const controller = new AbortController();
      let outcome: "pending" | "success" | "failure" = "pending";
      const pending = executeWriteWithPreview(
        "queued",
        path,
        "stale",
        directory,
        controller.signal,
      ).then(
        () => {
          outcome = "success";
        },
        () => {
          outcome = "failure";
        },
      );
      // Let the owner enter the queue wait before cancellation.
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
      if (cancellation === "abort") controller.abort();
      else if (cancellation === "replacement") yield* step(() => start(h));
      else yield* step(() => shutdown(h));
      for (let turn = 0; turn < 30; turn++) {
        if (outcome !== "pending") break;
        yield* Effect.yieldNow;
      }
      assert.equal(
        outcome,
        "failure",
        "waiting caller must settle while predecessor is still held",
      );
      assert.equal(yield* fs.readFileString(path), "before");
      yield* Deferred.succeed(release, undefined);
      yield* step(() => predecessor);
      yield* step(() => pending);
      // Joining a fresh queue entry proves the revoked delayed callback has drained.
      yield* step(() => withFileMutationQueue(path, () => Promise.resolve()));
      assert.equal(yield* fs.readFileString(path), "before");
      if (cancellation !== "shutdown") {
        yield* step(() => executeWriteWithPreview("fresh", path, "fresh", directory, undefined));
        assert.equal(yield* fs.readFileString(path), "fresh");
      }
    }).pipe(provideBuiltLayer(nodeFilePlatformLayer)),
  );
}

for (const closing of ["replacement", "shutdown"] as const) {
  it.effect(`${closing} joins admitted native write callbacks and clears their evidence`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "preview-closing-write-" });
      const path = `${directory}/target.txt`;
      yield* fs.writeFileString(path, "before");
      const h = harness();
      yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
      yield* step(() => start(h));
      const owner = captureCodePreviewSessionCapability();
      assert.ok(owner);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delayed = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (target, next, options) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(fs.writeFileString(target, next, options)),
          ),
      });
      const pending = owner
        .run(
          executeWriteWithPreviewEffect("closing-write", path, "after", directory).pipe(
            Effect.provideService(FileSystem.FileSystem, delayed),
          ),
        )
        .then(
          () => "success" as const,
          () => "failure" as const,
        );
      yield* Deferred.await(entered);
      const close = yield* step(() => (closing === "replacement" ? start(h) : shutdown(h))).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      assert.equal(close.pollUnsafe(), undefined);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(close);
      assert.equal(yield* step(() => pending), "failure");
      assert.equal(yield* fs.readFileString(path), "after");
      assert.equal(lookupBeforeWrite("closing-write"), undefined);
      if (closing === "replacement") yield* step(() => shutdown(h));
    }).pipe(provideBuiltLayer(nodeFilePlatformLayer)),
  );
}

effectTest("captured capability cannot execute through a replacement slot", function* () {
  const h = harness();
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  yield* step(() => start(h));
  const old = captureCodePreviewSessionCapability();
  assert.ok(old);
  yield* step(() => start(h));
  let ran = false;
  yield* step(() =>
    assert.rejects(
      old.run(
        Effect.sync(() => {
          ran = true;
        }),
      ),
    ),
  );
  assert.equal(ran, false);
  yield* step(() => shutdown(h));
});

type HostContext = {
  cwd?: unknown;
  signal?: unknown;
  isProjectTrusted?: unknown;
  ui: { notify(message: string, level: string): void | PromiseLike<void> };
};
type Handler = (event: Readonly<Record<never, never>>, ctx: HostContext) => void | Promise<void>;

type HarnessOptions = {
  readonly load?: (
    call: number,
    cwd: string,
    projectTrusted: boolean,
  ) => Effect.Effect<CodePreviewSettings>;
  readonly initializeSyntax?: (theme: string) => Effect.Effect<void>;
};

const settings = { ...defaultCodePreviewSettings, syntaxHighlighting: false, tools: [] };

afterEach(() => {
  clearCodePreviewSessionCapability();
  setCodePreviewSettings(defaultCodePreviewSettings);
});

function harness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const startupEvents: string[] = [];
  const runSignals: Array<AbortSignal | undefined> = [];
  const forkSignals: Array<AbortSignal | undefined> = [];
  const syntaxThemes: string[] = [];
  const probe = makeLifecycleProbe("runtime-acquired", "runtime-released");
  let loadCalls = 0;
  const piFixture = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  };
  // SAFETY: Lifecycle tests invoke only on from this ExtensionAPI fixture.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const dependencies: CodePreviewExtensionDependencies = {
    registerHealth: () => undefined,
    registerSettings: () => undefined,
    registerRenderers: () => {
      startupEvents.push("renderers");
    },
    loadSettings: (_admission, cwd, projectTrusted) =>
      Effect.suspend(() => {
        startupEvents.push("settings");
        const call = loadCalls++;
        return (options.load?.(call, cwd, projectTrusted) ?? Effect.succeed(settings)).pipe(
          Effect.tap((loaded) => Effect.sync(() => setCodePreviewSettings(loaded))),
        );
      }),
    initializeSyntax: (theme) =>
      Effect.suspend(() => {
        syntaxThemes.push(theme);
        return options.initializeSyntax?.(theme) ?? Effect.void;
      }),
    makeRuntime: (runtimePi) => {
      const runtime = makePiManagedRuntime(
        runtimePi,
        Layer.merge(codePreviewApplicationLayer, probe.layer),
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
  const context = (signal?: AbortSignal): HostContext => {
    const value: HostContext = {
      cwd: "/project",
      isProjectTrusted: () => true,
      ui: {
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    };
    if (signal) value.signal = signal;
    return value;
  };
  return {
    pi,
    handlers,
    dependencies,
    context,
    notifications,
    startupEvents,
    syntaxThemes,
    probe,
    counts: () => ({
      acquisitions: probe.acquired(),
      releases: probe.released(),
      loads: loadCalls,
    }),
    signals: () => ({ run: [...runSignals], fork: [...forkSignals] }),
  };
}

function start(h: ReturnType<typeof harness>, ctx = h.context()): Promise<void> {
  // SAFETY: The extension registers session_start before this helper is called.
  return Promise.resolve(h.handlers.get("session_start")?.({}, ctx));
}

function shutdown(h: ReturnType<typeof harness>, ctx = h.context()): Promise<void> {
  // SAFETY: The extension registers session_shutdown before this helper is called.
  return Promise.resolve(h.handlers.get("session_shutdown")?.({}, ctx));
}

function builtinToolInfo(name: string): ToolInfo {
  return {
    name,
    description: `${name} tool`,
    // SAFETY: Lifecycle discovery reads only the tool name and source metadata.
    parameters: {} as ToolInfo["parameters"],
    sourceInfo: {
      path: "builtin",
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
  };
}

effectTest("factory registers callbacks without acquiring the application Layer", function* () {
  const h = harness();
  const registration = codePreviewsWithDependencies(h.pi, h.dependencies);
  assert.equal(h.handlers.has("session_start"), true);
  assert.equal(h.handlers.has("session_shutdown"), true);
  assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, loads: 0 });
  yield* step(() => registration);
});

effectTest("startup loads settings before renderers and activates the scheduler", function* () {
  const h = harness();
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));

  yield* step(() => start(h));

  assert.deepEqual(h.startupEvents, ["settings", "renderers"]);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 0, loads: 1 });
  assert.equal(hasCodePreviewSessionCapability(), true);
  assert.deepEqual(h.syntaxThemes, []);
  assert.deepEqual(h.signals().fork, []);
  yield* step(() => shutdown(h));
});

effectTest("replacement interrupts startup and releases each application Layer once", function* () {
  let interrupted = 0;
  const firstStarted = Deferred.makeUnsafe<void>();
  const h = harness({
    load: (call) =>
      call === 0
        ? Effect.sync(() => Deferred.doneUnsafe(firstStarted, Effect.void)).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => interrupted++)),
          )
        : Effect.succeed(settings),
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const first = start(h);
  yield* Deferred.await(firstStarted);

  const second = start(h);
  yield* step(() => second);
  yield* step(() => first);

  assert.equal(interrupted, 1);
  assert.deepEqual(h.counts(), { acquisitions: 2, releases: 1, loads: 2 });
  yield* step(() => shutdown(h));
  assert.equal(h.probe.released(), 2);
});

effectTest("abort interrupts pending startup and awaits its application finalizer", function* () {
  let interrupted = 0;
  const pending = Deferred.makeUnsafe<void>();
  const h = harness({
    load: () =>
      Effect.sync(() => Deferred.doneUnsafe(pending, Effect.void)).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => interrupted++)),
      ),
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const controller = new AbortController();
  const startup = start(h, h.context(controller.signal));
  yield* Deferred.await(pending);

  controller.abort();
  yield* step(() => startup);

  assert.equal(interrupted, 1);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, loads: 1 });
  assert.equal(hasCodePreviewSessionCapability(), false);
});

effectTest("shutdown releases exactly once and remains idempotent", function* () {
  const h = harness();
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  yield* step(() => start(h));

  yield* step(() => Promise.all([shutdown(h), shutdown(h), shutdown(h)]));

  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, loads: 1 });
  assert.equal(hasCodePreviewSessionCapability(), false);
});

effectTest("syntax activation uses the loaded theme and captured session signal", function* () {
  const syntaxStarted = Deferred.makeUnsafe<void>();
  const syntaxSettings = {
    ...settings,
    syntaxHighlighting: true,
    shikiTheme: "github-dark" as const,
  };
  const h = harness({
    load: () => Effect.succeed(syntaxSettings),
    initializeSyntax: () => Effect.sync(() => Deferred.doneUnsafe(syntaxStarted, Effect.void)),
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context();
  const captured = new AbortController().signal;
  const stale = new AbortController().signal;
  let signalReads = 0;
  Object.defineProperty(context, "signal", {
    configurable: true,
    get() {
      signalReads++;
      return signalReads === 1 ? captured : stale;
    },
  });

  yield* step(() => start(h, context));
  yield* Deferred.await(syntaxStarted);

  assert.equal(signalReads, 1);
  assert.deepEqual(h.syntaxThemes, ["github-dark"]);
  assert.equal(h.signals().run[0], captured);
  assert.equal(h.signals().fork[0], captured);
  yield* step(() => shutdown(h, context));
});

effectTest(
  "renderer registration failure notifies after settings and releases the Layer",
  function* () {
    const h = harness();
    const dependencies: CodePreviewExtensionDependencies = {
      ...h.dependencies,
      registerRenderers: () => {
        h.startupEvents.push("renderers");
        throw new Error("host renderer registration failure");
      },
    };
    yield* step(() => codePreviewsWithDependencies(h.pi, dependencies));

    yield* step(() => start(h));

    assert.deepEqual(h.startupEvents, ["settings", "renderers"]);
    assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, loads: 1 });
    assert.deepEqual(h.notifications, ["Code previews failed to start."]);
  },
);

effectTest("partial renderer registration keeps the session runtime live", function* () {
  const partialSettings = {
    ...settings,
    tools: ["bash", "read", "write"],
  } satisfies CodePreviewSettings;
  const h = harness({ load: () => Effect.succeed(partialSettings) });
  const attempts: string[] = [];
  Object.assign(h.pi, {
    getAllTools: () => ["bash", "read", "write"].map(builtinToolInfo),
    registerTool: (tool: ToolDefinition) => {
      attempts.push(tool.name);
      if (tool.name === "read") throw new Error("host mutation failed");
    },
  });
  const dependencies: CodePreviewExtensionDependencies = {
    ...h.dependencies,
    registerRenderers: (pi, cwd, options) =>
      registerToolRenderers(pi, cwd, { ...options, toolOptions: {} }),
  };
  yield* step(() => codePreviewsWithDependencies(h.pi, dependencies));

  yield* step(() => start(h));

  assert.deepEqual(attempts, ["bash", "read", "write"]);
  assert.equal(hasCodePreviewSessionCapability(), true);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 0, loads: 1 });
  assert.deepEqual(h.notifications, []);
  yield* step(() => shutdown(h));
});

effectTest("lifecycle retries a tool left visible by mutate-then-refresh failure", function* () {
  const retrySettings = {
    ...settings,
    tools: ["read"],
  } satisfies CodePreviewSettings;
  const h = harness({ load: () => Effect.succeed(retrySettings) });
  let visible = builtinToolInfo("read");
  let attempts = 0;
  Object.assign(h.pi, {
    getAllTools: () => [visible],
    registerTool: (tool: ToolDefinition) => {
      attempts++;
      visible = {
        ...builtinToolInfo(tool.name),
        sourceInfo: {
          path: "/extensions/pi-code-previews.ts",
          source: "pi-code-previews",
          scope: "user",
          origin: "top-level",
        },
      };
      if (attempts === 1) throw new Error("refresh failed after registry mutation");
    },
  });
  const dependencies: CodePreviewExtensionDependencies = {
    ...h.dependencies,
    registerRenderers: (pi, cwd, options) =>
      registerToolRenderers(pi, cwd, { ...options, toolOptions: {} }),
  };
  yield* step(() => codePreviewsWithDependencies(h.pi, dependencies));

  yield* step(() => start(h));
  yield* step(() => start(h));

  assert.equal(attempts, 2);
  assert.equal(hasCodePreviewSessionCapability(), true);
  assert.deepEqual(h.counts(), { acquisitions: 2, releases: 1, loads: 2 });
  yield* step(() => shutdown(h));
});

effectTest("getAllTools discovery failure reaches lifecycle startup handling", function* () {
  const h = harness({
    load: () => Effect.succeed({ ...settings, tools: ["bash"] }),
  });
  Object.assign(h.pi, {
    getAllTools: () => {
      throw new Error("host discovery failed");
    },
  });
  const dependencies: CodePreviewExtensionDependencies = {
    ...h.dependencies,
    registerRenderers: (pi, cwd, options) =>
      registerToolRenderers(pi, cwd, { ...options, toolOptions: {} }),
  };
  yield* step(() => codePreviewsWithDependencies(h.pi, dependencies));

  yield* step(() => start(h));

  assert.equal(hasCodePreviewSessionCapability(), false);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, loads: 1 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});

for (const property of ["cwd", "signal"] as const) {
  effectTest(`throwing session ${property} getters fail before runtime acquisition`, function* () {
    const h = harness();
    yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
    const context = h.context();
    Object.defineProperty(context, property, {
      configurable: true,
      get() {
        throw new Error(`host ${property} failure`);
      },
    });

    assert.doesNotThrow(() => h.handlers.get("session_start")?.({}, context));
    yield* settle(() => h.handlers.get("session_shutdown")?.({}, context));

    assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, loads: 0 });
    assert.deepEqual(h.notifications, ["Code previews failed to start."]);
  });
}

effectTest("throwing AbortSignal.aborted getters fail before runtime acquisition", function* () {
  const h = harness();
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context();
  context.signal = Object.defineProperty({}, "aborted", {
    get() {
      throw new Error("host aborted failure");
    },
  });

  yield* step(() => start(h, context));

  assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, loads: 0 });
  assert.deepEqual(h.notifications, ["Code previews failed to start."]);
});

effectTest("project trust fails closed unless the callback returns literal true", function* () {
  const observedTrust: boolean[] = [];
  const h = harness({
    load: (_call, _cwd, projectTrusted) => {
      observedTrust.push(projectTrusted);
      return Effect.succeed(settings);
    },
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const trustValues: unknown[] = [
    undefined,
    true,
    () => false,
    () => "true",
    () => {
      throw new Error("host trust failure");
    },
    () => true,
  ];

  for (const trust of trustValues) {
    const context = h.context();
    if (trust === undefined) delete context.isProjectTrusted;
    else context.isProjectTrusted = trust;
    yield* step(() => start(h, context));
  }

  assert.deepEqual(observedTrust, [false, false, false, false, false, true]);
  assert.deepEqual(h.notifications, []);
  yield* step(() => shutdown(h));
});

effectTest("throwing project trust getters fail closed", function* () {
  const observedTrust: boolean[] = [];
  const h = harness({
    load: (_call, _cwd, projectTrusted) => {
      observedTrust.push(projectTrusted);
      return Effect.succeed(settings);
    },
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context();
  Object.defineProperty(context, "isProjectTrusted", {
    get() {
      throw new Error("host trust getter failure");
    },
  });

  yield* step(() => start(h, context));

  assert.deepEqual(observedTrust, [false]);
  yield* step(() => shutdown(h, context));
});

effectTest("throwing notification callbacks cannot escape host capture failure", function* () {
  const h = harness();
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context();
  Object.defineProperty(context, "cwd", {
    get() {
      throw new Error("host cwd failure");
    },
  });
  context.ui.notify = () => {
    throw new Error("host notify failure");
  };

  assert.doesNotThrow(() => h.handlers.get("session_start")?.({}, context));
  yield* settle(() => h.handlers.get("session_shutdown")?.({}, context));
  assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, loads: 0 });
});

effectTest("rejecting notification thenables are contained", function* () {
  const h = harness({ load: () => Effect.die("settings failed") });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));
  const context = h.context();
  let notifications = 0;
  context.ui.notify = () => {
    notifications++;
    return Promise.reject(new Error("host notify rejection"));
  };

  yield* step(() => start(h, context));
  yield* Effect.yieldNow;

  assert.equal(notifications, 1);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, loads: 1 });
});
