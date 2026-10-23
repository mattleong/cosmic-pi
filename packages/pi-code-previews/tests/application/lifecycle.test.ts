import assert from "node:assert/strict";
import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime, nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  extensionContextFixture,
  makeLifecycleProbe,
  recordingExtensionHost,
  type ExtensionContextOverrides,
  type ExtensionHostContext,
  provideBuiltLayer,
} from "pi-cosmic-core/testing";
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
import { setCodePreviewSettings, setCodePreviewSettingsProblems } from "../../src/config/state";
import { codePreviewApplicationLayer } from "../../src/layer";
import { getShikiStatus, renderWithShiki } from "../../src/syntax/render";
import { registerWritePreviewTool } from "../../src/tools/renderers/registration";
import { effectTest, settle, step } from "../support/effect-test";
import { builtinToolInfo } from "../support/renderer-host";
import {
  executeWriteWithPreview,
  executeWriteWithPreviewEffect,
} from "../../src/write/preview-execution";
import { lookupBeforeWrite } from "../../src/write/projection";
import * as Arr from "effect/Array";

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
      const runPredecessor = Effect.runPromiseWith(yield* Effect.context());
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
      // Stands in for the host's abort signal, which Pi passes to the write tool.
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
          return undefined;
        },
        () => {
          outcome = "failure";
        },
      );
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

type HarnessOptions = {
  readonly load?: (
    call: number,
    cwd: string,
    projectTrusted: boolean,
  ) => Effect.Effect<CodePreviewSettings>;
  readonly initializeSyntax?: (theme: string) => Effect.Effect<void>;
  readonly realRenderers?: true;
};

const settings = { ...defaultCodePreviewSettings, syntaxHighlighting: false, tools: [] };

afterEach(() => {
  clearCodePreviewSessionCapability();
  setCodePreviewSettings(defaultCodePreviewSettings);
  setCodePreviewSettingsProblems([]);
});

function harness(options: HarnessOptions = {}) {
  const notifications: string[] = [];
  const startupEvents: string[] = [];
  const runSignals: Array<AbortSignal | undefined> = [];
  const forkSignals: Array<AbortSignal | undefined> = [];
  const syntaxThemes: string[] = [];
  const probe = makeLifecycleProbe("runtime-acquired", "runtime-released");
  let loadCalls = 0;
  const host = recordingExtensionHost(undefined, {
    getAllTools: () => [],
    getActiveTools: () => [],
    getCommands: () => [],
  });
  const dependencies: CodePreviewExtensionDependencies = {
    registerCommands: () => undefined,
    registerRenderers: options.realRenderers
      ? (rendererPi, cwd, rendererOptions) =>
          registerWritePreviewTool(rendererPi, cwd, rendererOptions)
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
  const context = (overrides: ExtensionContextOverrides = {}): ExtensionHostContext =>
    extensionContextFixture({
      cwd: "/project",
      isProjectTrusted: () => true,
      ...overrides,
      ui: {
        notify: (message) => {
          notifications.push(message);
        },
        ...overrides.ui,
      },
    });
  return {
    pi: host.pi,
    handlers: host.handlers,
    dispatch: (name: "session_start" | "session_shutdown", ctx: ExtensionHostContext = context()) =>
      host.emit(name, ctx),
    dependencies,
    context,
    notifications,
    startupEvents,
    syntaxThemes,
    resolvers: host.toolRenderers,
    probe,
    counts: () => ({
      acquisitions: probe.acquired(),
      releases: probe.released(),
      loads: loadCalls,
    }),
    signals: () => ({ run: [...runSignals], fork: [...forkSignals] }),
  };
}

function registered(options: HarnessOptions = {}) {
  const h = harness(options);
  return step(() => codePreviewsWithDependencies(h.pi, h.dependencies)).pipe(Effect.as(h));
}

function throwingGetter<Target extends object>(target: Target, property: string): Target {
  return Object.defineProperty(target, property, {
    configurable: true,
    get() {
      throw new Error(`host ${property} failure`);
    },
  });
}

const start = (h: ReturnType<typeof harness>, ctx = h.context()) =>
  h.dispatch("session_start", ctx);
const shutdown = (h: ReturnType<typeof harness>, ctx = h.context()) =>
  h.dispatch("session_shutdown", ctx);

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

effectTest(
  "TUI startup does not await speculative syntax and shutdown interrupts it",
  function* () {
    const entered = yield* Deferred.make<void>();
    let interrupted = false;
    const h = yield* registered({
      load: () => Effect.succeed({ ...settings, syntaxHighlighting: true }),
      initializeSyntax: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => (interrupted = true))),
        ),
    });
    yield* step(() => start(h, h.context({ mode: "tui" })));
    yield* Deferred.await(entered);
    assert.equal(hasCodePreviewSessionCapability(), true);
    yield* step(() => shutdown(h));
    assert.equal(interrupted, true);
  },
);

for (const mode of ["print", "json", "rpc"] as const)
  effectTest(
    `${mode} skips speculative syntax but historical rendering initializes on demand`,
    function* () {
      const h = yield* registered({
        load: () => Effect.succeed({ ...settings, syntaxHighlighting: true }),
      });
      yield* Effect.addFinalizer(() => step(() => shutdown(h)));
      yield* step(() => start(h, h.context({ mode })));
      assert.deepEqual(h.syntaxThemes, []);
      assert.equal(getShikiStatus().initialized, false);
      const ready = yield* Deferred.make<void>();
      const source = "const preserved = 1;";
      assert.equal(
        renderWithShiki(source, "typescript", () => Deferred.doneUnsafe(ready, Effect.void)),
        undefined,
      );
      yield* Deferred.await(ready);
      assert.equal(getShikiStatus().initialized, true);
      const rendered = renderWithShiki(source, "typescript");
      assert.ok(rendered);
      assert.match(Arr.join(rendered, "\n"), /preserved/);
      yield* step(() => shutdown(h));
      assert.equal(getShikiStatus().initialized, false);
    },
  );

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
  const startup = start(h, h.context({ signal: controller.signal }));
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
    assert.equal(h.notifications.length, 1);
  },
);

effectTest("a failed write hook keeps presentation and the session runtime live", function* () {
  const partialSettings = {
    ...settings,
    tools: ["bash", "read", "write"],
  } satisfies CodePreviewSettings;
  const h = harness({ load: () => Effect.succeed(partialSettings), realRenderers: true });
  const attempts: string[] = [];
  Object.assign(h.pi, {
    getAllTools: () => Arr.map(["bash", "read", "write"], (name) => builtinToolInfo(name)),
    registerTool: (tool: ToolDefinition) => {
      attempts.push(tool.name);
      if (tool.name === "write") throw new Error("host mutation failed");
    },
  });
  yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));

  yield* step(() => start(h));

  assert.deepEqual(attempts, ["write"]);
  assert.equal(h.resolvers.length, 1);
  assert.equal(hasCodePreviewSessionCapability(), true);
  assert.deepEqual(h.counts(), { acquisitions: 1, releases: 0, loads: 1 });
  assert.deepEqual(h.notifications, []);
  yield* step(() => shutdown(h));
});

effectTest(
  "lifecycle retries a write hook left visible by mutate-then-refresh failure",
  function* () {
    const retrySettings = {
      ...settings,
      tools: ["write"],
    } satisfies CodePreviewSettings;
    const h = harness({ load: () => Effect.succeed(retrySettings), realRenderers: true });
    const sourceInfo = {
      path: "/extensions/pi-code-previews.ts",
      source: "pi-code-previews",
      scope: "user",
      origin: "top-level",
    } as const;
    let visible = builtinToolInfo("write");
    let attempts = 0;
    Object.assign(h.pi, {
      getAllTools: () => [visible],
      getCommands: () => [{ name: "code-previews", source: "extension", sourceInfo }],
      registerTool: (tool: ToolDefinition) => {
        attempts++;
        visible = { ...builtinToolInfo(tool.name), sourceInfo };
        if (attempts === 1) throw new Error("refresh failed after registry mutation");
      },
    });
    yield* step(() => codePreviewsWithDependencies(h.pi, h.dependencies));

    yield* step(() => start(h));
    yield* step(() => start(h));

    assert.equal(attempts, 2);
    assert.equal(h.resolvers.length, 1);
    assert.equal(hasCodePreviewSessionCapability(), true);
    assert.deepEqual(h.counts(), { acquisitions: 2, releases: 1, loads: 2 });
    yield* step(() => shutdown(h));
  },
);

const captureFailures: ReadonlyArray<
  readonly [string, (h: ReturnType<typeof harness>) => ExtensionHostContext]
> = [["cwd getters", (h) => throwingGetter(h.context(), "cwd")]];

for (const [name, sabotaged] of captureFailures)
  effectTest(`throwing session ${name} fail before runtime acquisition`, function* () {
    const h = yield* registered();
    const context = sabotaged(h);

    assert.doesNotThrow(() => h.dispatch("session_start", context));
    yield* settle(() => h.dispatch("session_shutdown", context));

    assert.deepEqual(h.counts(), { acquisitions: 0, releases: 0, loads: 0 });
    assert.equal(h.notifications.length, 1);
  });

effectTest("project trust fails closed unless the callback returns literal true", function* () {
  const observedTrust: boolean[] = [];
  const h = yield* registered({
    load: (_call, _cwd, projectTrusted) => {
      observedTrust.push(projectTrusted);
      return Effect.succeed(settings);
    },
  });
  const trustValues: ReadonlyArray<() => boolean> = [
    () => false,
    () => {
      throw new Error("host trust failure");
    },
    () => true,
  ];

  for (const trust of trustValues)
    yield* step(() => start(h, h.context({ isProjectTrusted: trust })));
  yield* step(() => start(h, throwingGetter(h.context(), "isProjectTrusted")));

  assert.deepEqual(observedTrust, [false, false, true, false]);
  assert.deepEqual(h.notifications, []);
  yield* step(() => shutdown(h));
});
