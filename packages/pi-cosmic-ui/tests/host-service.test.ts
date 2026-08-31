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
  type AtomicJsonDocumentStoreContract,
  type JsonObject,
} from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { HostCallbackBoundary, makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { extensionContextFixture } from "./support/host.ts";
import { CosmicUiConfigStore } from "../src/config/store.ts";
import { CosmicUiService, makeProjection } from "../src/protocol/service.ts";
import { makePiExec } from "../src/boundary/host-exec.ts";
import {
  makeFooterProtocolBuffer,
  protocolRemove,
  protocolUpsert,
  type FooterProtocolEvent,
} from "../src/protocol/host.ts";
import {
  COSMIC_UI_PROTOCOL_VERSION,
  normalizeCosmicFooterUpsertEvent,
} from "../src/protocol/protocol.ts";

function documents(initial: Readonly<Record<string, JsonObject>> = {}) {
  const memory = makeInMemoryDocuments(initial);
  return { values: memory.documents, layer: memory.layer };
}

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

/** Deferred-backed pending host exec promise released explicitly by the test. */
const deferredExecResult = () => {
  const handle = Deferred.makeUnsafe<ExecResult>();
  return {
    promise: Effect.runPromise(Deferred.await(handle)),
    release: (value: ExecResult) => {
      Effect.runSync(Deferred.succeed(handle, value));
    },
  };
};

/** Deferred-backed pending host exec promise that rejects when the probe signal aborts. */
const abortablePendingExec = (
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<ExecResult> => {
  const handle = Deferred.makeUnsafe<ExecResult, Error>();
  signal?.addEventListener(
    "abort",
    () => {
      onAbort();
      Effect.runSync(Deferred.fail(handle, new Error("aborted")));
    },
    { once: true },
  );
  return Effect.runPromise(Deferred.await(handle));
};

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
  const baseServiceOptions = {
    context: contextRef,
    cwd: "/project",
    exec: makePiExec(exec),
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
  return { layer, projection, contextRef, callbacks, documents: store.values };
}

const protocolEventId = (event: FooterProtocolEvent): string | undefined =>
  event._tag === "Remove" ? event.id : undefined;

describe("FooterProtocolBuffer", () => {
  it.effect("detaches raw contributions and reuses normalized frozen contributions", () => {
    const buffer = makeFooterProtocolBuffer(3);
    const raw = {
      kind: "text" as const,
      id: "raw",
      region: "metrics" as const,
      text: "before",
    };
    const normalized = normalizeCosmicFooterUpsertEvent({
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "normalized-owner",
      contribution: {
        kind: "text",
        id: "normalized",
        region: "metrics",
        text: "stable",
      },
    });
    const surfaceSource = {
      kind: "surface" as const,
      id: "surface",
      region: "media" as const,
      preferredWidth: 10,
      state: "owned",
      render() {
        expect(this).toBe(surfaceSource);
        return [this.state];
      },
    };
    const normalizedSurface = normalizeCosmicFooterUpsertEvent({
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "surface-owner",
      contribution: surfaceSource,
    });
    if (!normalized || !normalizedSurface)
      throw new Error("Expected valid normalized contributions.");
    expect(buffer.offer(protocolUpsert("raw-owner", raw))).toBe("accepted");
    expect(buffer.offer(protocolUpsert(normalized.owner, normalized.contribution))).toBe(
      "accepted",
    );
    expect(
      buffer.offer(protocolUpsert(normalizedSurface.owner, normalizedSurface.contribution)),
    ).toBe("accepted");
    raw.text = "after";
    const drained: FooterProtocolEvent[] = [];

    return buffer
      .drain((event) => Effect.sync(() => drained.push(event)))
      .pipe(
        Effect.andThen(
          Effect.sync(() => {
            expect(drained[0]?._tag).toBe("Upsert");
            if (drained[0]?._tag === "Upsert") {
              expect(drained[0].contribution).not.toBe(raw);
              expect(drained[0].contribution).toMatchObject({ text: "before" });
              expect(Object.isFrozen(drained[0].contribution)).toBe(true);
            }
            expect(drained[1]?._tag).toBe("Upsert");
            if (drained[1]?._tag === "Upsert")
              expect(drained[1].contribution).toBe(normalized.contribution);
            expect(drained[2]?._tag).toBe("Upsert");
            if (drained[2]?._tag === "Upsert") {
              expect(drained[2].contribution).toBe(normalizedSurface.contribution);
              expect(drained[2].contribution.kind).toBe("surface");
              if (drained[2].contribution.kind === "surface")
                expect(
                  drained[2].contribution.render({
                    width: 10,
                    placement: "inline-right",
                    theme: { fg: (_color, value) => value },
                  }),
                ).toEqual(["owned"]);
            }
          }),
        ),
      );
  });

  it.effect("restores the failed event and untouched suffix in FIFO order", () => {
    const buffer = makeFooterProtocolBuffer(4);
    for (const id of ["a", "b", "c"])
      expect(buffer.offer(protocolRemove("owner", id))).toBe("accepted");
    const first: Array<string | undefined> = [];
    const replayed: Array<string | undefined> = [];

    return Effect.gen(function* () {
      yield* buffer
        .drain((event) => {
          const id = protocolEventId(event);
          first.push(id);
          return id === "b" ? Effect.fail("stop") : Effect.void;
        })
        .pipe(Effect.ignore);

      expect(buffer.offer(protocolRemove("owner", "d"))).toBe("accepted");
      yield* buffer.drain((event) => Effect.sync(() => replayed.push(protocolEventId(event))));

      expect(first).toEqual(["a", "b"]);
      expect(replayed).toEqual(["b", "c", "d"]);
    });
  });

  it.effect("reset invalidates an active drain's reservation and failure restoration", () => {
    const buffer = makeFooterProtocolBuffer(1);
    expect(buffer.offer(protocolRemove("owner", "old"))).toBe("accepted");

    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* buffer
        .drain(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail("stop")),
          ),
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      buffer.reset();
      expect(buffer.offer(protocolRemove("owner", "fresh"))).toBe("accepted");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber).pipe(Effect.ignore);
      expect(buffer.offer(protocolRemove("owner", "newest"))).toBe("accepted");

      const drained: Array<string | undefined> = [];
      yield* buffer.drain((event) => Effect.sync(() => drained.push(protocolEventId(event))));
      expect(drained).toEqual(["newest"]);
    }).pipe(Effect.scoped);
  });

  it.effect("reserves drained capacity across yields and synchronously flushes activation", () => {
    const buffer = makeFooterProtocolBuffer(2);
    expect(buffer.offer(protocolRemove("owner", "a"))).toBe("accepted");
    expect(buffer.offer(protocolRemove("owner", "b"))).toBe("accepted");

    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const drained: Array<string | undefined> = [];
      const fiber = yield* buffer
        .drain((event) =>
          Effect.sync(() => drained.push(protocolEventId(event))).pipe(
            Effect.andThen(
              protocolEventId(event) === "a"
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
            ),
          ),
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      expect(buffer.offer(protocolRemove("owner", "c"))).toBe("dropped");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(drained).toEqual(["a", "b"]);

      expect(buffer.offer(protocolRemove("owner", "c"))).toBe("accepted");
      const activated: Array<string | undefined> = [];
      buffer.activate((event) => {
        activated.push(protocolEventId(event));
        return "accepted";
      });
      expect(activated).toEqual(["c"]);
      expect(buffer.offer(protocolRemove("owner", "d"))).toBe("accepted");
      expect(activated).toEqual(["c", "d"]);
    }).pipe(Effect.scoped);
  });
});

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
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("handles Git/gh nonzero results, parses diffs, and throttles pull requests", () => {
    let gitCalls = 0;
    let pullRequestCalls = 0;
    const { layer, projection } = serviceLayer((command, args) => {
      if (command === "gh") {
        pullRequestCalls++;
        return Promise.resolve({ stdout: "42\n", stderr: "", code: 0, killed: false });
      }
      gitCalls++;
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
    }).pipe(provideBuiltLayer(layer));
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
    }).pipe(provideBuiltLayer(layer));
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
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("discards stale completions after the callback context changes", () => {
    const pending = deferredExecResult();
    const contextRef = MutableRef.make(context("/first"));
    const { layer, projection } = serviceLayer(() => pending.promise, { context: contextRef });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      const fiber = yield* service.refreshGit(true).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      MutableRef.set(contextRef, context("/second"));
      pending.release({ stdout: "## main\n M stale.ts\n", stderr: "", code: 0, killed: false });
      yield* Fiber.join(fiber);
      expect(MutableRef.get(projection).gitStatus).toBeUndefined();
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("accepts probe results across fresh same-session context objects", () => {
    const pending = deferredExecResult();
    const contextRef = MutableRef.make(context("/project"));
    const { layer, projection } = serviceLayer(() => pending.promise, { context: contextRef });
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      const fiber = yield* service.refreshGit(true).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      MutableRef.set(contextRef, context("/project"));
      pending.release({ stdout: "## main\n M current.ts\n", stderr: "", code: 0, killed: false });
      yield* Fiber.join(fiber);
      expect(MutableRef.get(projection).gitStatus?.modified).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("invalidates old-branch Git and PR completions before forced follow-ups", () => {
    const oldResolvers = new Map<string, Deferred.Deferred<ExecResult>>();
    const nextResolvers = new Map<string, Deferred.Deferred<ExecResult>>();
    const calls = new Map<string, number>();
    const { layer, projection } = serviceLayer((command) => {
      const occurrence = (calls.get(command) ?? 0) + 1;
      calls.set(command, occurrence);
      const handle = Deferred.makeUnsafe<ExecResult>();
      (occurrence === 1 ? oldResolvers : nextResolvers).set(command, handle);
      return Effect.runPromise(Deferred.await(handle));
    });
    const result = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
    const resolveWith = (
      handle: Deferred.Deferred<ExecResult> | undefined,
      value: ExecResult,
    ): Effect.Effect<void> =>
      handle ? Effect.asVoid(Deferred.succeed(handle, value)) : Effect.void;
    return Effect.gen(function* () {
      const service = yield* CosmicUiService;
      const old = yield* service.refreshAll(true).pipe(Effect.forkScoped);
      while (oldResolvers.size < 2) yield* Effect.yieldNow;
      yield* service.invalidateProbes;
      const next = yield* service.refreshAll(true).pipe(Effect.forkScoped);
      yield* resolveWith(oldResolvers.get("git"), result("## old\n M old.ts\n"));
      yield* resolveWith(oldResolvers.get("gh"), result("1\n"));
      while (nextResolvers.size < 2) yield* Effect.yieldNow;
      expect(MutableRef.get(projection).gitStatus).toBeUndefined();
      expect(MutableRef.get(projection).pullRequestNumber).toBeUndefined();
      yield* resolveWith(nextResolvers.get("git"), result("## new\n"));
      yield* resolveWith(nextResolvers.get("gh"), result("2\n"));
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
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
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
          if (pending) {
            started++;
            return abortablePendingExec(options?.signal, () => {
              aborted++;
            });
          }
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
      }).pipe(provideBuiltLayer(layer));
      return program;
    },
  );

  it.effect("interrupts manually requested probes when the service scope closes", () => {
    let started = 0;
    let aborted = 0;
    const { layer } = serviceLayer((_command, _args, options) => {
      started++;
      return abortablePendingExec(options?.signal, () => {
        aborted++;
      });
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
