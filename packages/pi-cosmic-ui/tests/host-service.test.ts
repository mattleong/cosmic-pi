import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  AgentDirectory,
  decodeUnknownOrUndefined,
  JsonDocumentStore,
  type JsonDocumentStoreContract,
  type JsonObject,
} from "pi-cosmic-core";
import {
  deferredPromise,
  extensionContextFixture,
  type InMemoryDocuments,
  makeInMemoryDocuments,
  provideBuiltLayer,
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
    onUsageChange?: () => void;
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
    sessionManager: MutableRef.get(contextRef).sessionManager,
    cwd: "/project",
    projection,
    onChange: options.onChange ?? (() => undefined),
    onUsageChange: options.onUsageChange,
    canPublish: options.canPublish,
    startPolling: options.startPolling ?? false,
    projectTrusted: options.projectTrusted ?? true,
  }).pipe(Layer.provide(Layer.merge(repository, probe)));
  return { layer, projection, contextRef, documents: store.documents };
}

type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;
const nativeUsage = (input: number) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const usageEntry = (input: number, usage = nativeUsage(input)): SessionEntries[number] => ({
  id: "entry",
  parentId: null,
  timestamp: "2026-01-01T00:00:00Z",
  type: "usage",
  kind: "cache_warm",
  provider: "test",
  model: "test",
  usage,
});

type Resolve = (value: ExecResult) => void;
const resolveWith = (resolve: Resolve | undefined, value: ExecResult) =>
  Effect.sync(() => resolve?.(value));

describe("Cosmic UI host service", () => {
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
      yield* service.invalidateProbes();
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

  it.effect(
    "reconciles persisted usage on the Effect clock and keeps the last complete totals",
    () => {
      let entries: SessionEntries = [];
      let unreadable = false;
      let usageChanges = 0;
      let changes = 0;
      const contextRef = MutableRef.make(
        extensionContextFixture({
          cwd: "/project",
          mode: "tui",
          sessionManager: {
            getCwd: () => "/project",
            getEntries: () => {
              if (unreadable) throw new Error("session closed");
              return entries;
            },
          },
        }),
      );
      const { layer, projection } = serviceLayer({
        context: contextRef,
        startPolling: true,
        onUsageChange: () => void usageChanges++,
        onChange: () => void changes++,
      });
      const input = () => MutableRef.get(projection).totals.input;
      return Effect.gen(function* () {
        yield* CosmicUiService;
        entries = [usageEntry(10)];
        yield* TestClock.adjust("999 millis");
        expect(input()).toBe(0);
        yield* TestClock.adjust("1 millis");
        yield* yieldUntil(() => input() === 10);
        expect({ usageChanges, changes }).toEqual({ usageChanges: 1, changes: 1 });

        // An unreadable session, or one entry with unreadable usage, never replaces complete totals.
        unreadable = true;
        yield* TestClock.adjust("1 second");
        unreadable = false;
        entries = [usageEntry(10), usageEntry(5, { ...nativeUsage(5), input: -1 })];
        yield* TestClock.adjust("1 second");
        expect(input()).toBe(10);
        expect(usageChanges).toBe(1);

        entries = [usageEntry(10), usageEntry(15)];
        yield* TestClock.adjust("1 second");
        yield* yieldUntil(() => input() === 25);
        expect(usageChanges).toBe(2);
      }).pipe(provideBuiltLayer(layer));
    },
  );

  it.effect("repairs a usage notification interrupted after its totals were published", () => {
    let entries: SessionEntries = [];
    let usageChanges = 0;
    let changes = 0;
    let interruptAtPublication: Fiber.Fiber<void> | undefined;
    const published = Deferred.makeUnsafe<void>();
    const contextRef = MutableRef.make(
      extensionContextFixture({
        cwd: "/project",
        mode: "tui",
        sessionManager: { getCwd: () => "/project", getEntries: () => entries },
      }),
    );
    const { layer, projection } = serviceLayer({
      context: contextRef,
      // The projection publishes through this check inside its uninterruptible commit, so an
      // interruption requested here lands exactly after the totals are published.
      canPublish: () => {
        const target = interruptAtPublication;
        interruptAtPublication = undefined;
        if (target) {
          target.interruptUnsafe();
          Deferred.doneUnsafe(published, Effect.void);
        }
        return true;
      },
      onUsageChange: () => void usageChanges++,
      onChange: () => void changes++,
    });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      entries = [usageEntry(10)];
      const interrupted = yield* service.reconcileUsage().pipe(Effect.forkChild);
      interruptAtPublication = interrupted;
      yield* Deferred.await(published);
      const exit = yield* Fiber.await(interrupted);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(MutableRef.get(projection).totals.input).toBe(10);
      expect({ usageChanges, changes }).toEqual({ usageChanges: 0, changes: 0 });

      // Unchanged persisted totals still repair the invalidation and render that were skipped.
      yield* service.reconcileUsage();
      expect({ usageChanges, changes }).toEqual({ usageChanges: 1, changes: 1 });
      yield* service.reconcileUsage();
      expect({ usageChanges, changes }).toEqual({ usageChanges: 1, changes: 1 });
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
