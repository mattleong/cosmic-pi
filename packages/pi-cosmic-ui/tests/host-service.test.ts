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
  provideBuiltLayer,
  type JsonDocumentStoreContract,
  type JsonObject,
} from "pi-cosmic-core";
import {
  deferredPromise,
  extensionContextFixture,
  makeInMemoryDocuments,
} from "pi-cosmic-core/testing";
import { HostCallbackBoundary, makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { abortablePendingExec, execOk, execResult, type ExecResult } from "./support/host.ts";
import { CosmicUiConfigStore } from "../src/config/store.ts";
import { CosmicUiService, makeProjection } from "../src/protocol/service.ts";
import { makePiExec } from "../src/boundary/host-exec.ts";

function documents(initial: Readonly<Record<string, JsonObject>> = {}) {
  const memory = makeInMemoryDocuments(initial);
  return { values: memory.documents, layer: memory.layer };
}

const context = (cwd = "/project"): ExtensionContext =>
  extensionContextFixture({ cwd, mode: "tui", sessionManager: { getCwd: () => cwd } });

function serviceLayer(
  options: {
    exec?: ExtensionAPI["exec"];
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
  const baseServiceOptions = {
    context: contextRef,
    cwd: "/project",
    exec: makePiExec(options.exec ?? (() => execOk())),
    projection,
    onChange() {},
    startPolling: options.startPolling ?? false,
  };
  const serviceOptions = options.omitProjectTrust
    ? baseServiceOptions
    : { ...baseServiceOptions, projectTrusted: options.projectTrusted ?? true };
  const layer = CosmicUiService.layer(serviceOptions).pipe(
    Layer.provide(Layer.merge(repository, HostCallbackBoundary.layer(callbacks))),
  );
  return { layer, projection, contextRef, documents: store.values };
}

describe("Cosmic UI host service", () => {
  it.effect("treats omitted project trust as untrusted", () => {
    const projectPath = "/project/.pi/extensions/pi-cosmic-ui.json";
    const globalPath = "/agent/extensions/pi-cosmic-ui.json";
    const { layer, projection } = serviceLayer({
      omitProjectTrust: true,
      documents: {
        [projectPath]: { footer: { density: "compact" } },
        [globalPath]: { footer: { density: "comfortable" } },
      },
    });
    return Effect.gen(function* () {
      yield* CosmicUiService;
      expect(MutableRef.get(projection).config?.configPath).toBe(globalPath);
      expect(MutableRef.get(projection).config?.footer.density).toBe("comfortable");
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("handles Git/gh nonzero results, parses diffs, and throttles pull requests", () => {
    let gitCalls = 0;
    let pullRequestCalls = 0;
    const { layer, projection } = serviceLayer({
      exec: (command, args) => {
        if (command === "gh") {
          pullRequestCalls++;
          return execOk("42\n");
        }
        gitCalls++;
        return execOk(args.includes("diff") ? "10\t4\ta.ts\n" : "## main...origin/main\n M a.ts\n");
      },
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
      expect(gitCalls).toBe(2);
      expect(pullRequestCalls).toBe(1);
      yield* service.refreshAll();
      expect(gitCalls).toBe(4);
      expect(pullRequestCalls).toBe(1);
      yield* TestClock.adjust("30 seconds");
      yield* service.refreshAll();
      expect(gitCalls).toBe(6);
      expect(pullRequestCalls).toBe(2);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("coalesces concurrent Git refresh bursts", () => {
    let calls = 0;
    const { layer } = serviceLayer({
      exec: () => {
        calls++;
        return execOk("## main\n");
      },
    });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      yield* Effect.all(
        Array.from({ length: 20 }, () => service.refreshGit(true)),
        { concurrency: "unbounded", discard: true },
      );
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(2);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("degrades nonzero and failed probes without failing refresh", () => {
    let fail = false;
    const { layer, projection } = serviceLayer({
      exec: (command) =>
        fail
          ? Promise.reject(new Error("unavailable"))
          : Promise.resolve(execResult(command === "gh" ? "" : "fatal", 1)),
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
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("keeps polling after hostile live context getters recover", () => {
    let failures = 0;
    const contextRef = MutableRef.make(
      extensionContextFixture(
        Object.defineProperty(
          {
            sessionManager: {
              getCwd() {
                failures += 1;
                throw new Error("cwd host failure");
              },
            },
          },
          "mode",
          {
            get() {
              failures += 1;
              throw new Error("mode host failure");
            },
          },
        ),
      ),
    );
    const cwds: string[] = [];
    const { layer } = serviceLayer({
      exec: (_command, _args, options) => {
        cwds.push(options?.cwd ?? "");
        return execOk("## main\n");
      },
      context: contextRef,
      startPolling: true,
    });
    return Effect.gen(function* () {
      yield* CosmicUiService;
      yield* TestClock.adjust("2 seconds");
      while (failures < 2) yield* Effect.yieldNow;
      expect(cwds).toEqual([]);

      MutableRef.set(contextRef, context("/recovered"));
      yield* TestClock.adjust("2 seconds");
      while (cwds.length === 0) yield* Effect.yieldNow;
      expect(cwds.every((cwd) => cwd === "/recovered")).toBe(true);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect.each([
    ["/second", undefined],
    ["/project", 1],
  ] as const)(
    "keeps a completion only when a fresh callback context stays in the session (%s)",
    ([cwd, modified]) => {
      const pending = deferredPromise<ExecResult>();
      const contextRef = MutableRef.make(context("/project"));
      const { layer, projection } = serviceLayer({
        exec: () => pending.promise,
        context: contextRef,
      });
      return Effect.gen(function* () {
        const service = yield* CosmicUiService;
        const fiber = yield* service.refreshGit(true).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        MutableRef.set(contextRef, context(cwd));
        pending.resolve(execResult("## main\n M a.ts\n"));
        yield* Fiber.join(fiber);
        expect(MutableRef.get(projection).gitStatus?.modified).toBe(modified);
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect("invalidates old-branch Git and PR completions before forced follow-ups", () => {
    type Resolve = (value: ExecResult) => void;
    const oldResolvers = new Map<string, Resolve>();
    const nextResolvers = new Map<string, Resolve>();
    const calls = new Map<string, number>();
    const { layer, projection } = serviceLayer({
      exec: (command) => {
        const occurrence = (calls.get(command) ?? 0) + 1;
        calls.set(command, occurrence);
        const handle = deferredPromise<ExecResult>();
        (occurrence === 1 ? oldResolvers : nextResolvers).set(command, handle.resolve);
        return handle.promise;
      },
    });
    const resolveWith = (resolve: Resolve | undefined, value: ExecResult) =>
      Effect.sync(() => resolve?.(value));
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      const old = yield* service.refreshAll(true).pipe(Effect.forkScoped);
      while (oldResolvers.size < 2) yield* Effect.yieldNow;
      yield* service.invalidateProbes;
      const next = yield* service.refreshAll(true).pipe(Effect.forkScoped);
      yield* resolveWith(oldResolvers.get("git"), execResult("## old\n M old.ts\n"));
      yield* resolveWith(oldResolvers.get("gh"), execResult("1\n"));
      while (nextResolvers.size < 2) yield* Effect.yieldNow;
      expect(MutableRef.get(projection).gitStatus).toBeUndefined();
      expect(MutableRef.get(projection).pullRequestNumber).toBeUndefined();
      yield* resolveWith(nextResolvers.get("git"), execResult("## new\n"));
      yield* resolveWith(nextResolvers.get("gh"), execResult("2\n"));
      yield* Fiber.join(old);
      yield* Fiber.join(next);
      expect(MutableRef.get(projection).gitStatus).toMatchObject({ modified: 0 });
      expect(MutableRef.get(projection).pullRequestNumber).toBe(2);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("serializes rapid visibility edits against the latest document", () => {
    const configPath = "/project/.pi/extensions/pi-cosmic-ui.json";
    const {
      layer,
      projection,
      documents: values,
    } = serviceLayer({ documents: { [configPath]: { footer: { hidden: [] } } } });
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
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("publishes a committed config before honoring interruption", () =>
    Effect.gen(function* () {
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const configPath = "/project/.pi/extensions/pi-cosmic-ui.json";
      const memory = makeInMemoryDocuments({
        [configPath]: { footer: { density: "comfortable" } },
      });
      const modifyObject: JsonDocumentStoreContract["modifyObject"] = (path, modify) =>
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
      const gated = { ...memory.service, modifyObject } satisfies JsonDocumentStoreContract;
      const store = {
        values: memory.documents,
        layer: Layer.succeed(JsonDocumentStore, gated),
      };
      const { layer, projection } = serviceLayer({ store });

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
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    }),
  );

  it.effect("polls on the Effect clock and recovers from failures", () => {
    let calls = 0;
    let failing = false;
    const { layer } = serviceLayer({
      exec: () => {
        calls++;
        return failing ? Promise.reject(new Error("unavailable")) : execOk("## main\n");
      },
      startPolling: true,
    });
    return Effect.gen(function* () {
      yield* CosmicUiService;
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
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("interrupts manually requested probes when the service scope closes", () => {
    let started = 0;
    let aborted = 0;
    const { layer } = serviceLayer({
      exec: (_command, _args, options) => {
        started++;
        return abortablePendingExec(options?.signal, () => {
          aborted++;
        });
      },
    });
    const program = Effect.gen(function* () {
      const service = yield* CosmicUiService;
      yield* service.refreshAll(true).pipe(Effect.forkScoped);
      while (started < 2) yield* Effect.yieldNow;
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
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
