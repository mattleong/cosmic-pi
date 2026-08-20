// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/strictEffectProvide:off
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import {
  AgentDirectory,
  JsonDocumentStore,
  PiApi,
  type AtomicJsonDocumentStoreContract,
  type JsonObject,
} from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { HostCallbackBoundary, makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { extensionContextFixture } from "./support/host.ts";
import { CosmicUiConfigStore } from "../src/config/store.ts";
import { CosmicUiService, makeProjection } from "../src/protocol/service.ts";
import { PiExec } from "../src/probe/pi-exec.ts";
import { RepositoryProbe } from "../src/probe/repository-probe.ts";

function documents(initial: Readonly<Record<string, JsonObject>> = {}) {
  const memory = makeInMemoryDocuments(initial);
  return { values: memory.documents, layer: memory.layer };
}

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const context = (cwd = "/project") =>
  ({
    cwd,
    mode: "tui",
    sessionManager: { getCwd: () => cwd },
  }) as ExtensionContext;

function serviceLayer(
  exec: ExtensionAPI["exec"],
  options: {
    startPolling?: boolean;
    context?: MutableRef.MutableRef<ExtensionContext>;
    documents?: Readonly<Record<string, JsonObject>>;
    store?: ReturnType<typeof documents>;
    omitProjectTrust?: boolean;
    projectTrusted?: boolean;
  } = {},
) {
  const projection = makeProjection();
  const contextRef = options.context ?? MutableRef.make(context());
  const callbacks = makeHostCallbackBoundary();
  const store = options.store ?? documents(options.documents);
  const platform = Layer.mergeAll(store.layer, Path.layer, AgentDirectory.layer("/agent"));
  const repository = CosmicUiConfigStore.layer.pipe(Layer.provide(platform));
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  const probe = RepositoryProbe.layer.pipe(
    Layer.provide(PiExec.layer),
    Layer.provide(PiApi.layer({ exec } as ExtensionAPI)),
  );
  const baseServiceOptions = {
    context: contextRef,
    cwd: "/project",
    projection,
    onChange() {},
    startPolling: options.startPolling ?? false,
  };
  const serviceOptions = options.omitProjectTrust
    ? baseServiceOptions
    : { ...baseServiceOptions, projectTrusted: options.projectTrusted ?? true };
  const layer = CosmicUiService.layer(serviceOptions).pipe(
    Layer.provide(Layer.mergeAll(repository, probe, HostCallbackBoundary.layer(callbacks))),
  );
  return { layer, projection, contextRef, callbacks, documents: store.values };
}

describe("Cosmic UI host service", () => {
  it.effect("treats omitted project trust as untrusted", () => {
    const projectPath = "/project/.pi/extensions/pi-cosmic-ui.json";
    const globalPath = "/agent/extensions/pi-cosmic-ui.json";
    const { layer, projection } = serviceLayer(
      () => Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false }),
      {
        omitProjectTrust: true,
        documents: {
          [projectPath]: { footer: { density: "compact" } },
          [globalPath]: { footer: { density: "comfortable" } },
        },
      },
    );
    return Effect.gen(function* () {
      yield* CosmicUiService;
      expect(MutableRef.get(projection).config?.configPath).toBe(globalPath);
      expect(MutableRef.get(projection).config?.footer.density).toBe("comfortable");
    }).pipe(Effect.provide(layer));
  });

  it.effect("handles Git/gh nonzero results, parses diffs, and throttles pull requests", () => {
    let calls = 0;
    const { layer, projection } = serviceLayer((command, args) => {
      calls++;
      if (command === "gh")
        return Promise.resolve({ stdout: "42\n", stderr: "", code: 0, killed: false });
      if (args.includes("diff"))
        return Promise.resolve({ stdout: "10\t4\ta.ts\n", stderr: "", code: 0, killed: false });
      return Promise.resolve({
        stdout: "## main...origin/main\n M a.ts\n",
        stderr: "",
        code: 0,
        killed: false,
      });
    });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      yield* service.refreshAll(true);
      expect(MutableRef.get(projection).gitStatus).toMatchObject({
        modified: 1,
        linesAdded: 6,
        linesChanged: 4,
      });
      expect(MutableRef.get(projection).pullRequestNumber).toBe(42);
      expect(calls).toBe(3);
      yield* service.refreshPullRequest();
      expect(calls).toBe(3);
      yield* TestClock.adjust("30 seconds");
      yield* service.refreshPullRequest();
      expect(calls).toBe(4);
    }).pipe(Effect.provide(layer));
  });

  it.effect("coalesces concurrent Git refresh bursts", () => {
    let calls = 0;
    const { layer } = serviceLayer(() => {
      calls++;
      return Promise.resolve({ stdout: "## main\n", stderr: "", code: 0, killed: false });
    });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      yield* Effect.all(
        Array.from({ length: 20 }, () => service.refreshGit(true)),
        { concurrency: "unbounded", discard: true },
      );
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("degrades nonzero and failed probes without failing refresh", () => {
    let fail = false;
    const { layer, projection } = serviceLayer((command) => {
      if (fail) return Promise.reject(new Error("unavailable"));
      return Promise.resolve({
        stdout: command === "gh" ? "" : "fatal",
        stderr: "",
        code: 1,
        killed: false,
      });
    });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      yield* service.refreshAll(true);
      expect(MutableRef.get(projection).gitStatus).toBeUndefined();
      expect(MutableRef.get(projection).pullRequestNumber).toBeUndefined();
      fail = true;
      yield* service.refreshAll(true);
      expect(MutableRef.get(projection).gitStatus).toBeUndefined();
      expect(MutableRef.get(projection).pullRequestNumber).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps polling after hostile live context getters recover", () => {
    const contextRef = MutableRef.make(
      extensionContextFixture(
        Object.defineProperty(
          {
            sessionManager: {
              getCwd() {
                throw new Error("cwd host failure");
              },
            },
          },
          "mode",
          {
            get() {
              throw new Error("mode host failure");
            },
          },
        ),
      ),
    );
    const cwds: string[] = [];
    const { layer, callbacks } = serviceLayer(
      (_command, _args, options) => {
        cwds.push(options?.cwd ?? "");
        return Promise.resolve({ stdout: "## main\n", stderr: "", code: 0, killed: false });
      },
      { context: contextRef, startPolling: true },
    );
    return Effect.gen(function* () {
      yield* CosmicUiService;
      yield* TestClock.adjust("2 seconds");
      while (callbacks.diagnostics().length < 2) yield* Effect.yieldNow;
      expect(cwds).toEqual([]);

      MutableRef.set(contextRef, context("/recovered"));
      yield* TestClock.adjust("2 seconds");
      while (cwds.length === 0) yield* Effect.yieldNow;
      expect(cwds.every((cwd) => cwd === "/recovered")).toBe(true);
      expect(callbacks.diagnostics().every(({ operation }) => operation === "host-query")).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("discards stale completions after the callback context changes", () => {
    let release!: (value: Awaited<ReturnType<ExtensionAPI["exec"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<ExtensionAPI["exec"]>>>((resolve) => {
      release = resolve;
    });
    const contextRef = MutableRef.make(context("/first"));
    const { layer, projection } = serviceLayer(() => pending, { context: contextRef });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      const fiber = yield* service.refreshGit(true).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      MutableRef.set(contextRef, context("/second"));
      release({ stdout: "## main\n M stale.ts\n", stderr: "", code: 0, killed: false });
      yield* Fiber.join(fiber);
      expect(MutableRef.get(projection).gitStatus).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("accepts probe results across fresh same-session context objects", () => {
    let release!: (value: Awaited<ReturnType<ExtensionAPI["exec"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<ExtensionAPI["exec"]>>>((resolve) => {
      release = resolve;
    });
    const contextRef = MutableRef.make(context("/project"));
    const { layer, projection } = serviceLayer(() => pending, { context: contextRef });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      const fiber = yield* service.refreshGit(true).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      MutableRef.set(contextRef, context("/project"));
      release({ stdout: "## main\n M current.ts\n", stderr: "", code: 0, killed: false });
      yield* Fiber.join(fiber);
      expect(MutableRef.get(projection).gitStatus?.modified).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("invalidates old-branch Git and PR completions before forced follow-ups", () => {
    const oldResolvers = new Map<
      string,
      (value: Awaited<ReturnType<ExtensionAPI["exec"]>>) => void
    >();
    const nextResolvers = new Map<
      string,
      (value: Awaited<ReturnType<ExtensionAPI["exec"]>>) => void
    >();
    const calls = new Map<string, number>();
    const { layer, projection } = serviceLayer((command) => {
      const occurrence = (calls.get(command) ?? 0) + 1;
      calls.set(command, occurrence);
      return new Promise((resolve) =>
        (occurrence === 1 ? oldResolvers : nextResolvers).set(command, resolve),
      );
    });
    const result = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      const old = yield* service.refreshAll(true).pipe(Effect.forkScoped);
      while (oldResolvers.size < 2) yield* Effect.yieldNow;
      yield* service.invalidateProbes;
      const next = yield* service.refreshAll(true).pipe(Effect.forkScoped);
      oldResolvers.get("git")?.(result("## old\n M old.ts\n"));
      oldResolvers.get("gh")?.(result("1\n"));
      while (nextResolvers.size < 2) yield* Effect.yieldNow;
      expect(MutableRef.get(projection).gitStatus).toBeUndefined();
      expect(MutableRef.get(projection).pullRequestNumber).toBeUndefined();
      nextResolvers.get("git")?.(result("## new\n"));
      nextResolvers.get("gh")?.(result("2\n"));
      yield* Fiber.join(old);
      yield* Fiber.join(next);
      expect(MutableRef.get(projection).gitStatus).toMatchObject({ modified: 0 });
      expect(MutableRef.get(projection).pullRequestNumber).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("serializes rapid visibility edits against the latest document", () => {
    const configPath = "/project/.pi/extensions/pi-cosmic-ui.json";
    const {
      layer,
      projection,
      documents: values,
    } = serviceLayer(() => Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false }), {
      documents: { [configPath]: { footer: { hidden: [] } } },
    });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      yield* Effect.all(
        [
          service.setFooterVisibility("metrics", false),
          service.setFooterVisibility("session", false),
        ],
        { concurrency: "unbounded", discard: true },
      );
      expect([...(MutableRef.get(projection).config?.footer.hidden ?? [])].sort()).toEqual([
        "metrics",
        "session",
      ]);
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const saved = values.get(configPath)?.footer as { hidden?: string[] } | undefined;
      expect([...(saved?.hidden ?? [])].sort()).toEqual(["metrics", "session"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("publishes a committed config before honoring interruption", () =>
    Effect.gen(function* () {
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const configPath = "/project/.pi/extensions/pi-cosmic-ui.json";
      const memory = makeInMemoryDocuments({
        [configPath]: { footer: { density: "comfortable" } },
      });
      const modifyObject: AtomicJsonDocumentStoreContract["modifyObject"] = (path, modify) =>
        memory.service.modifyObject(path, (document) =>
          modify(document).pipe(
            Effect.map((modification) => ({
              ...modification,
              afterCommit: Deferred.succeed(commitStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCommit)),
                Effect.andThen(modification.afterCommit ?? Effect.void),
              ),
            })),
          ),
        );
      const gated = { ...memory.service, modifyObject } satisfies AtomicJsonDocumentStoreContract;
      const store = {
        values: memory.documents,
        layer: Layer.succeed(JsonDocumentStore, gated),
      };
      const { layer, projection } = serviceLayer(
        () => Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false }),
        { store },
      );

      yield* Effect.gen(function* () {
        const service = yield* CosmicUiService;
        const update = yield* service
          .updateFooterConfig({ density: "compact" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(commitStarted);
        // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
        const saved = memory.documents.get(configPath)?.footer as { density?: string } | undefined;
        expect(saved?.density).toBe("compact");
        expect(MutableRef.get(projection).config?.footer.density).toBe("comfortable");

        const interruption = yield* Fiber.interrupt(update).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(MutableRef.get(projection).config?.footer.density).toBe("comfortable");
        yield* Deferred.succeed(releaseCommit, undefined);
        yield* Fiber.join(interruption);

        expect(MutableRef.get(projection).config?.footer.density).toBe("compact");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect(
    "polls on the Effect clock, recovers from failures, and interrupts in-flight probes",
    () => {
      let calls = 0;
      let failing = false;
      let pending = false;
      let started = 0;
      let aborted = 0;
      const { layer } = serviceLayer(
        (_command, _args, options) => {
          calls++;
          if (pending)
            return new Promise((_resolve, reject) => {
              started++;
              options?.signal?.addEventListener(
                "abort",
                () => {
                  aborted++;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            });
          if (failing) return Promise.reject(new Error("unavailable"));
          return Promise.resolve({ stdout: "## main\n", stderr: "", code: 0, killed: false });
        },
        { startPolling: true },
      );
      const program = Effect.gen(function* () {
        const service = yield* CosmicUiService;
        yield* TestClock.adjust("1999 millis");
        expect(calls).toBe(0);
        yield* TestClock.adjust("1 millis");
        while (calls < 1) yield* Effect.yieldNow;
        expect(calls).toBe(1);

        failing = true;
        yield* TestClock.adjust("2 seconds");
        while (calls < 2) yield* Effect.yieldNow;
        failing = false;
        yield* TestClock.adjust("2 seconds");
        while (calls < 3) yield* Effect.yieldNow;

        pending = true;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* service.refreshAll(true).pipe(Effect.forkScoped);
            while (started < 2) yield* Effect.yieldNow;
          }),
        );
        expect(aborted).toBe(2);
      }).pipe(Effect.provide(layer));
      return program;
    },
  );

  it.effect("interrupts manually requested probes when the service scope closes", () => {
    let started = 0;
    let aborted = 0;
    const { layer } = serviceLayer(
      (_command, _args, options) =>
        new Promise((resolve, reject) => {
          started++;
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted++;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          void resolve;
        }),
    );
    const program = Effect.gen(function* () {
      const service = yield* CosmicUiService;
      yield* service.refreshAll(true).pipe(Effect.forkScoped);
      while (started < 2) yield* Effect.yieldNow;
    }).pipe(Effect.scoped, Effect.provide(layer));
    return program.pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(started).toBe(2);
          expect(aborted).toBe(2);
        }),
      ),
    );
  });
});
