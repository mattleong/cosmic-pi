// Test lifecycle boundary intentionally uses Promise-shaped host callbacks and AbortController.
import assert from "node:assert/strict";
import {
  withFileMutationQueue,
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
import { extensionApiFixture, makeLifecycleProbe, opaqueFixture } from "pi-cosmic-core/testing";
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
      const h = yield* registered();
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
      const h = yield* registered();
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
  const h = yield* registered();
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
  /** Uses the real tool-renderer registration instead of recording a startup event. */
  readonly realRenderers?: true;
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
  const pi = extensionApiFixture({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  });
  const dependencies: CodePreviewExtensionDependencies = {
    registerCommands: () => undefined,
    registerRenderers: options.realRenderers
      ? (rendererPi, cwd, rendererOptions) =>
          registerToolRenderers(rendererPi, cwd, { ...rendererOptions, toolOptions: {} })
      : () => {
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

/** Builds a harness and registers the extension without starting a session. */
function registered(options: HarnessOptions = {}) {
  const h = harness(options);
  return step(() => codePreviewsWithDependencies(h.pi, h.dependencies)).pipe(Effect.as(h));
}

/** Makes one host-context property throw whenever it is read. */
function throwingGetter<Target extends object>(target: Target, property: string): Target {
  return Object.defineProperty(target, property, {
    configurable: true,
    get() {
      throw new Error(`host ${property} failure`);
    },
  });
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
    parameters: opaqueFixture({}),
    exposure: "direct",
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
  const h = yield* registered();

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
  const h = yield* registered({
    load: (call) =>
      call === 0
        ? Effect.sync(() => Deferred.doneUnsafe(firstStarted, Effect.void)).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => interrupted++)),
          )
        : Effect.succeed(settings),
  });
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
  const h = yield* registered({
    load: () =>
      Effect.sync(() => Deferred.doneUnsafe(pending, Effect.void)).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => interrupted++)),
      ),
  });
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
  const h = yield* registered();
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
  const h = yield* registered({
    load: () => Effect.succeed(syntaxSettings),
    initializeSyntax: () => Effect.sync(() => Deferred.doneUnsafe(syntaxStarted, Effect.void)),
  });
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
    assert.deepEqual(h.notifications, ["Code Previews couldn't start"]);
  },
);

effectTest("partial renderer registration keeps the session runtime live", function* () {
  const partialSettings = {
    ...settings,
    tools: ["bash", "read", "write"],
  } satisfies CodePreviewSettings;
  const h = harness({ load: () => Effect.succeed(partialSettings), realRenderers: true });
  const attempts: string[] = [];
  Object.assign(h.pi, {
    getAllTools: () => ["bash", "read", "write"].map(builtinToolInfo),
    registerTool: (tool: ToolDefinition) => {
      attempts.push(tool.name);
      if (tool.name === "read") throw new Error("host mutation failed");
    },
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));

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
  const h = harness({ load: () => Effect.succeed(retrySettings), realRenderers: true });
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
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));

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
    realRenderers: true,
  });
  Object.assign(h.pi, {
    getAllTools: () => {
      throw new Error("host discovery failed");
    },
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));

  yield* step(() => start(h));

  assert.equal(hasCodePreviewSessionCapability(), false);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 1, loads: 1 });
  assert.deepEqual(h.notifications, ["Code Previews couldn't start"]);
});

const captureFailures: ReadonlyArray<readonly [string, (context: HostContext) => void]> = [
  ["cwd getters", (context) => throwingGetter(context, "cwd")],
  ["signal getters", (context) => throwingGetter(context, "signal")],
  ["AbortSignal.aborted getters", (context) => (context.signal = throwingGetter({}, "aborted"))],
];

for (const [name, sabotage] of captureFailures)
  effectTest(`throwing session ${name} fail before runtime acquisition`, function* () {
    const h = yield* registered();
    const context = h.context();
    sabotage(context);

    assert.doesNotThrow(() => h.handlers.get("session_start")?.({}, context));
    yield* settle(() => h.handlers.get("session_shutdown")?.({}, context));

    assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, loads: 0 });
    assert.deepEqual(h.notifications, ["Code Previews couldn't start"]);
  });

effectTest("project trust fails closed unless the callback returns literal true", function* () {
  const observedTrust: boolean[] = [];
  const h = yield* registered({
    load: (_call, _cwd, projectTrusted) => {
      observedTrust.push(projectTrusted);
      return Effect.succeed(settings);
    },
  });
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
  yield* step(() => start(h, throwingGetter(h.context(), "isProjectTrusted")));

  assert.deepEqual(observedTrust, [false, false, false, false, false, true, false]);
  assert.deepEqual(h.notifications, []);
  yield* step(() => shutdown(h));
});

effectTest("throwing notification callbacks cannot escape host capture failure", function* () {
  const h = yield* registered();
  const context = throwingGetter(h.context(), "cwd");
  context.ui.notify = () => {
    throw new Error("host notify failure");
  };

  assert.doesNotThrow(() => h.handlers.get("session_start")?.({}, context));
  yield* settle(() => h.handlers.get("session_shutdown")?.({}, context));
  assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, loads: 0 });
});

effectTest("rejecting notification thenables are contained", function* () {
  const h = yield* registered({ load: () => Effect.die("settings failed") });
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
