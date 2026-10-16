import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as core from "pi-cosmic-core";
import { vi } from "vitest";
import * as TestClock from "effect/testing/TestClock";
import {
  AgentDirectory,
  decodeUnknownOrUndefined,
  JsonDocumentStore,
  provideBuiltLayer,
  type JsonDocumentStoreContract,
  type JsonObject,
} from "pi-cosmic-core";
import {
  deferredPromise,
  extensionContextFixture,
  makeInMemoryDocuments,
  pausedScheduler,
  type InMemoryDocuments,
  yieldUntil,
} from "pi-cosmic-core/testing";
import { abortablePendingExec, execOk, execResult, type ExecResult } from "./support/host.ts";
import { CosmicUiConfigStore } from "../src/config/store.ts";
import { CosmicUiService, createProjection, resetProjection } from "../src/protocol/service.ts";
import { PiExec } from "../src/boundary/host-exec.ts";
import { RepositoryProbe } from "../src/probe/repository-probe.ts";

const SavedFooter = Schema.Struct({
  hidden: Schema.optional(Schema.Array(Schema.String)),
  density: Schema.optional(Schema.String),
});

const context = (cwd = "/project"): ExtensionContext =>
  extensionContextFixture({ cwd, mode: "tui", sessionManager: { getCwd: () => cwd } });

function serviceLayer(
  options: {
    exec?: ExtensionAPI["exec"];
    startPolling?: boolean;
    context?: MutableRef.MutableRef<ExtensionContext>;
    documents?: Readonly<Record<string, JsonObject>>;
    store?: Pick<InMemoryDocuments, "documents" | "layer">;
    projectTrusted?: boolean;
    canPublish?: () => boolean;
    onChange?: () => void;
  } = {},
) {
  const projection = createProjection();
  const contextRef = options.context ?? MutableRef.make(context());
  const store = options.store ?? makeInMemoryDocuments(options.documents);
  const platform = Layer.mergeAll(store.layer, Path.layer, AgentDirectory.layer("/agent"));
  const repository = CosmicUiConfigStore.layer.pipe(Layer.provide(platform));
  const probe = RepositoryProbe.layer.pipe(
    Layer.provide(PiExec.layerFrom(options.exec ?? (() => execOk()))),
  );
  const layer = CosmicUiService.layer({
    context: contextRef,
    cwd: "/project",
    projection,
    onChange: options.onChange ?? (() => undefined),
    canPublish: options.canPublish,
    startPolling: options.startPolling ?? false,
    projectTrusted: options.projectTrusted ?? true,
  }).pipe(Layer.provide(Layer.merge(repository, probe)));
  return { layer, projection, contextRef, documents: store.documents };
}

type Resolve = (value: ExecResult) => void;
const resolveWith = (resolve: Resolve | undefined, value: ExecResult) =>
  Effect.sync(() => resolve?.(value));

describe("Cosmic UI host service", () => {
  it.effect("reads only the global document for an untrusted project", () => {
    const projectPath = "/project/.pi/extensions/pi-cosmic-ui.json";
    const globalPath = "/agent/extensions/pi-cosmic-ui.json";
    const { layer, projection } = serviceLayer({
      projectTrusted: false,
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
          return execOk('{"number":42,"url":"https://git.example.test/team/project/pull/42"}');
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
      expect(MutableRef.get(projection).pullRequestUrl).toBe(
        "https://git.example.test/team/project/pull/42",
      );
      expect(gitCalls).toBe(2);
      expect(pullRequestCalls).toBe(1);
      yield* service.refreshAll();
      expect(gitCalls).toBe(4);
      expect(pullRequestCalls).toBe(1);
      yield* TestClock.adjust("30 seconds");
      yield* service.refreshAll();
      expect(gitCalls).toBe(6);
      expect(pullRequestCalls).toBe(2);
      yield* service.invalidateProbes;
      expect(MutableRef.get(projection).pullRequestNumber).toBeUndefined();
      expect(MutableRef.get(projection).pullRequestUrl).toBeUndefined();
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
    let outcome: "success" | "nonzero" | "rejection" = "success";
    const { layer, projection } = serviceLayer({
      exec: (command) => {
        if (outcome === "rejection") return Promise.reject(new Error("unavailable"));
        if (outcome === "nonzero") return Promise.resolve(execResult("unavailable", 1));
        return execOk(
          command === "gh"
            ? '{"number":42,"url":"https://git.example.test/team/project/pull/42"}'
            : "## main\n",
        );
      },
    });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      for (const failure of ["nonzero", "rejection"] as const) {
        outcome = "success";
        yield* service.refreshAll(true);
        expect(MutableRef.get(projection).pullRequestUrl).toBeDefined();
        outcome = failure;
        yield* service.refreshAll(true);
        expect(MutableRef.get(projection).gitStatus).toBeUndefined();
        expect(MutableRef.get(projection).pullRequestNumber).toBeUndefined();
        expect(MutableRef.get(projection).pullRequestUrl).toBeUndefined();
      }
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
      yield* yieldUntil(() => failures >= 2);
      expect(cwds).toEqual([]);

      MutableRef.set(contextRef, context("/recovered"));
      yield* TestClock.adjust("2 seconds");
      yield* yieldUntil(() => cwds.length > 0);
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
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      const old = yield* service.refreshAll(true).pipe(Effect.forkScoped);
      yield* yieldUntil(() => oldResolvers.size === 2);
      yield* service.invalidateProbes;
      const next = yield* service.refreshAll(true).pipe(Effect.forkScoped);
      yield* resolveWith(oldResolvers.get("git"), execResult("## old\n M old.ts\n"));
      yield* resolveWith(
        oldResolvers.get("gh"),
        execResult('{"number":1,"url":"https://git.example.test/team/project/pull/1"}'),
      );
      yield* yieldUntil(() => nextResolvers.size === 2);
      expect(MutableRef.get(projection).gitStatus).toBeUndefined();
      expect(MutableRef.get(projection).pullRequestNumber).toBeUndefined();
      expect(MutableRef.get(projection).pullRequestUrl).toBeUndefined();
      yield* resolveWith(nextResolvers.get("git"), execResult("## new\n"));
      yield* resolveWith(
        nextResolvers.get("gh"),
        execResult('{"number":2,"url":"https://git.example.test/team/project/pull/2"}'),
      );
      yield* Fiber.join(old);
      yield* Fiber.join(next);
      expect(MutableRef.get(projection).gitStatus).toMatchObject({ modified: 0 });
      expect(MutableRef.get(projection).pullRequestNumber).toBe(2);
      expect(MutableRef.get(projection).pullRequestUrl).toBe(
        "https://git.example.test/team/project/pull/2",
      );
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("branch invalidation cannot clear state ahead of a post-validation Git commit", () =>
    Effect.gen(function* () {
      const paused = pausedScheduler();
      let armed = false;
      let validated = false;
      let stopped = false;
      const makeRefresh = core.createSubscriptionRefresh;
      const observedRefresh: typeof makeRefresh = (options) =>
        makeRefresh({
          ...options,
          commit: (value) => {
            if (armed) validated = true;
            return options.commit(value);
          },
        });
      const boundary = vi
        .spyOn(core, "createSubscriptionRefresh")
        .mockImplementation(observedRefresh);
      const contextRef = MutableRef.make(context());
      const { layer, projection } = serviceLayer({
        context: contextRef,
        exec: () => execOk("## same-branch\n"),
      });
      yield* Effect.gen(function* () {
        const service = yield* CosmicUiService;
        yield* service.refreshGit(true);
        const before = MutableRef.get(projection).gitStatus;
        expect(before).toBeDefined();
        armed = true;
        const scheduler: Scheduler.Scheduler = {
          executionMode: paused.scheduler.executionMode,
          makeDispatcher: () => paused.scheduler.makeDispatcher(),
          shouldYield: () => {
            if (!validated || stopped) return false;
            stopped = true;
            return true;
          },
        };
        const refresh = yield* service
          .refreshGit(true)
          .pipe(
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkScoped({ startImmediately: true }),
          );
        try {
          yield* yieldUntil(() => stopped);
          const invalidated = yield* Deferred.make<void>();
          const invalidation = yield* service.invalidateProbes.pipe(
            Effect.andThen(Deferred.succeed(invalidated, undefined)),
            Effect.forkScoped,
          );
          for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
          expect(yield* Deferred.isDone(invalidated)).toBe(false);
          expect(MutableRef.get(projection).gitStatus).toEqual(before);
          expect(MutableRef.get(projection).probeRevision).toBe(0);
          paused.resume();
          yield* Fiber.join(refresh);
          yield* Fiber.join(invalidation);
          expect(MutableRef.get(projection).gitStatus).toBeUndefined();
          expect(MutableRef.get(projection).probeRevision).toBe(1);
          yield* service.refreshAll(true);
          expect(MutableRef.get(projection).gitStatus).toBeDefined();
        } finally {
          paused.resume();
          boundary.mockRestore();
        }
      }).pipe(provideBuiltLayer(layer));
    }),
  );

  it.effect("serializes rapid visibility edits against the latest document", () => {
    const configPath = "/project/.pi/extensions/pi-cosmic-ui.json";
    const { layer, projection, documents } = serviceLayer({
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
      expect((MutableRef.get(projection).config?.footer.hidden ?? []).toSorted()).toEqual([
        "metrics",
        "session",
      ]);
      const saved = decodeUnknownOrUndefined(SavedFooter)(documents.get(configPath)?.footer);
      expect((saved?.hidden ?? []).toSorted()).toEqual(["metrics", "session"]);
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
      const { layer, projection } = serviceLayer({
        store: { ...memory, layer: Layer.succeed(JsonDocumentStore, gated) },
      });

      yield* Effect.gen(function* () {
        const service = yield* CosmicUiService;
        const update = yield* service
          .updateFooterConfig({ density: "compact" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(commitStarted);
        const saved = decodeUnknownOrUndefined(SavedFooter)(
          memory.documents.get(configPath)?.footer,
        );
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

  it.effect(
    "a revoked session keeps a masked config commit durable without republishing or repainting",
    () =>
      Effect.gen(function* () {
        const configPath = "/project/.pi/extensions/pi-cosmic-ui.json";
        const memory = makeInMemoryDocuments({
          [configPath]: { footer: { density: "comfortable" } },
        });
        let current = true;
        let changes = 0;
        const { layer, projection } = serviceLayer({
          store: memory,
          canPublish: () => current,
          onChange: () => {
            changes++;
          },
        });
        const committed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const service = yield* CosmicUiService;
          memory.blockNextUpdateAtCommit(committed, release);
          const update = yield* service
            .updateFooterConfig({ density: "compact" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(committed);
          current = false;
          resetProjection(projection);
          const reset = MutableRef.get(projection);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(update);
          expect(memory.documents.get(configPath)).toMatchObject({
            footer: { density: "compact" },
          });
          expect(MutableRef.get(projection)).toBe(reset);
          expect(changes).toBe(0);
        }).pipe(provideBuiltLayer(layer));
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
      yield* yieldUntil(() => calls >= 1);
      expect(calls).toBe(1);

      failing = true;
      yield* TestClock.adjust("2 seconds");
      yield* yieldUntil(() => calls >= 2);
      failing = false;
      yield* TestClock.adjust("2 seconds");
      yield* yieldUntil(() => calls >= 3);
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
      yield* yieldUntil(() => started === 2);
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
