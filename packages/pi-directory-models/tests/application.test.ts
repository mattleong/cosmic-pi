import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  extensionContextFixture,
  opaqueFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { registerDirectoryModelsApplication } from "../src/application.ts";
import { preferenceFilename } from "../src/config/path-key.ts";
import {
  DirectoryModelPreferenceSchema,
  makeDirectoryModelPreference,
  type DirectoryModelPreference,
} from "../src/config/schema.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

type Model = NonNullable<ExtensionContext["model"]>;

const PreferenceFromJson = Schema.fromJsonString(DirectoryModelPreferenceSchema);

const model = (provider: string, id: string): Model =>
  opaqueFixture({ provider, id, reasoning: true });

const entryBase = (id: string) => ({
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const userEntry = (id: string): SessionEntry => ({
  ...entryBase(id),
  type: "message",
  message: { role: "user", content: "hello", timestamp: 0 },
});

const customEntry = (id: string): SessionEntry => ({
  ...entryBase(id),
  type: "custom",
  customType: "test",
});

const preferencePath = (agentDirectory: string, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonical = yield* fs.realPath(cwd);
    return path.join(
      agentDirectory,
      "pi-directory-models",
      preferenceFilename(canonical, path.basename(canonical)),
    );
  });

const readPreference = (agentDirectory: string, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const serialized = yield* fs.readFileString(yield* preferencePath(agentDirectory, cwd));
    return yield* Schema.decodeEffect(PreferenceFromJson)(serialized);
  });

/** Writes a preference document stamped with `documentCwd`, or the canonical cwd by default. */
const writePreference = (
  agentDirectory: string,
  cwd: string,
  preference: Omit<DirectoryModelPreference, "cwd" | "version">,
  documentCwd?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = yield* preferencePath(agentDirectory, cwd);
    yield* fs.makeDirectory(path.join(agentDirectory, "pi-directory-models"), { recursive: true });
    const serialized = yield* Schema.encodeUnknownEffect(PreferenceFromJson)(
      makeDirectoryModelPreference(
        documentCwd ?? (yield* fs.realPath(cwd)),
        preference.provider,
        preference.model,
        preference.thinkingLevel,
      ),
    );
    yield* fs.writeFileString(target, `${serialized}\n`);
    return target;
  });

const harness = (
  options: {
    readonly explicitPreference?: boolean;
    readonly entries?: readonly SessionEntry[];
    readonly leafId?: string | null;
    readonly sessionReadFailure?: "entries" | "leaf" | "both";
    readonly cwd?: string;
    readonly delayThinkingEvents?: boolean;
    readonly modelReadFailure?: boolean;
    readonly setModelDenied?: boolean;
    readonly setModelSettlement?: Promise<void>;
    readonly onSetModel?: () => void;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const realCwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-directory-models-project-" });
    const agentDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "pi-directory-models-agent-",
    });
    const cwd = options.cwd ?? realCwd;
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory));

    const initial = model("anthropic", "claude-sonnet");
    const remembered = model("openai-codex", "gpt-5.6-sol");
    const rememberedPreference = {
      provider: remembered.provider,
      model: remembered.id,
      thinkingLevel: "high" as const,
    };
    const alternate = model("xai", "grok-code");
    const available = new Map(
      [initial, remembered, alternate].map((value) => [`${value.provider}/${value.id}`, value]),
    );
    let activeModel = initial;
    let thinkingLevel: "low" | "medium" | "high" = "low";
    const notify = vi.fn();
    let ctx!: ExtensionContext;
    const delayedThinkingEvents: unknown[] = [];
    const setModel = vi.fn((next: Model): Promise<boolean> => {
      options.onSetModel?.();
      return Promise.resolve(options.setModelSettlement).then(() => {
        if (options.setModelDenied) return false;
        const previousModel = activeModel;
        activeModel = next;
        return host
          .emit("model_select", ctx, {
            type: "model_select",
            model: next,
            previousModel,
            source: "set",
          })
          .then(() => true);
      });
    });
    const setThinkingLevel = vi.fn((level: typeof thinkingLevel) => {
      const previousLevel = thinkingLevel;
      thinkingLevel = level;
      const event = { type: "thinking_level_select", level, previousLevel };
      if (options.delayThinkingEvents) delayedThinkingEvents.push(event);
      else void host.emit("thinking_level_select", ctx, event);
    });
    const host = recordingExtensionHost(
      {},
      { setModel, getThinkingLevel: () => thinkingLevel, setThinkingLevel },
    );
    const getEntries = vi.fn(() => {
      if (options.sessionReadFailure === "entries" || options.sessionReadFailure === "both") {
        throw new Error("entries read failed");
      }
      return [...(options.entries ?? [])];
    });
    const getLeafId = vi.fn(() => {
      if (options.sessionReadFailure === "leaf" || options.sessionReadFailure === "both") {
        throw new Error("leaf read failed");
      }
      if (options.leafId !== undefined) return options.leafId;
      return options.entries?.at(-1)?.id ?? null;
    });
    ctx = extensionContextFixture({
      cwd,
      get model() {
        if (options.modelReadFailure) throw new Error("model getter failed");
        return activeModel;
      },
      modelRegistry: {
        find(provider: string, id: string) {
          return available.get(`${provider}/${id}`);
        },
      },
      sessionManager: { getEntries, getLeafId },
      ui: { notify },
    });
    registerDirectoryModelsApplication(host.pi, options.explicitPreference ?? false);

    const emit = <Event>(name: string, event: Event): Effect.Effect<void> =>
      Effect.promise(() => host.emit(name, ctx, event));
    const start = (reason: "startup" | "new" | "resume" | "fork" | "reload" = "startup") =>
      emit("session_start", { type: "session_start", reason });
    const shutdown = () => emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    yield* Effect.addFinalizer(() => shutdown());

    return {
      cwd,
      agentDirectory,
      initial,
      remembered,
      rememberedPreference,
      seedRememberedPreference: () => writePreference(agentDirectory, cwd, rememberedPreference),
      readPreference: () => readPreference(agentDirectory, cwd),
      preferenceExists: () => Effect.flatMap(preferencePath(agentDirectory, cwd), fs.exists),
      alternate,
      notify,
      getEntries,
      getLeafId,
      setModel,
      setThinkingLevel,
      start,
      shutdown,
      emitModel: (model: Model, previousModel: Model, source: "set" | "restore" = "set") =>
        emit("model_select", { type: "model_select", model, previousModel, source }),
      emitThinking: (level: string, previousLevel: string) =>
        emit("thinking_level_select", { type: "thinking_level_select", level, previousLevel }),
      select(next: Model, thinking: "low" | "medium" | "high" = thinkingLevel) {
        activeModel = next;
        thinkingLevel = thinking;
      },
      model: () => activeModel,
      thinking: () => thinkingLevel,
      flushThinkingEvents: () =>
        Effect.suspend(() =>
          Effect.forEach(
            delayedThinkingEvents.splice(0),
            (event) => Effect.promise(() => host.emit("thinking_level_select", ctx, event)),
            { discard: true },
          ),
        ),
    };
  });

layer(nodeFilePlatformLayer)("directory models application", (it) => {
  it.effect("initializes a readable preference for an ordinary fresh session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* harness();
      yield* h.start();

      expect(yield* h.readPreference()).toMatchObject({
        cwd: yield* fs.realPath(h.cwd),
        provider: h.initial.provider,
        model: h.initial.id,
        thinkingLevel: "low",
      });
    }),
  );

  it.effect("restores model and thinking for fresh startup and /new", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.seedRememberedPreference();

      yield* h.start();
      expect(h.setModel).toHaveBeenCalledWith(h.remembered);
      expect(h.thinking()).toBe("high");

      h.select(h.initial, "low");
      yield* h.start("new");
      expect(h.setModel).toHaveBeenLastCalledWith(h.remembered);
      expect(h.thinking()).toBe("high");
    }),
  );

  it.effect("waits for a noncancelable model settlement before a successor session starts", () => {
    const settlement = Deferred.makeUnsafe<void>();
    const settlementPromise = Effect.runPromise(Deferred.await(settlement));
    return Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>();
      const h = yield* harness({
        setModelSettlement: settlementPromise,
        onSetModel: () => Deferred.doneUnsafe(admitted, Effect.void),
      });
      yield* h.seedRememberedPreference();
      const first = yield* h.start().pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(admitted);
      const successorSettled = yield* Deferred.make<void>();
      const successor = yield* h
        .start("new")
        .pipe(
          Effect.ensuring(Deferred.succeed(successorSettled, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* Effect.yieldNow;

      expect(yield* Deferred.isDone(successorSettled)).toBe(false);

      yield* Deferred.succeed(settlement, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(successor);
      expect(h.setModel).toHaveBeenCalledTimes(1);
      expect(h.thinking()).toBe("high");
      expect(h.notify).not.toHaveBeenCalled();
    }).pipe(
      // Release the host call before scoped fibers and harness shutdown are finalized.
      Effect.ensuring(Deferred.succeed(settlement, undefined)),
    );
  });

  it.effect("leaves explicit CLI preferences alone", () =>
    Effect.gen(function* () {
      const h = yield* harness({ explicitPreference: true });
      yield* h.start();
      expect(yield* h.preferenceExists()).toBe(false);
      expect(h.setModel).not.toHaveBeenCalled();
      yield* h.start("new");
      expect(yield* h.preferenceExists()).toBe(false);
    }),
  );

  it.effect("uses Pi's resolved session context to classify startup freshness", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        entries: readonly SessionEntry[];
        leafId?: string;
        initializes: boolean;
      }> = [
        { entries: [userEntry("user")], initializes: false },
        { entries: [customEntry("custom")], initializes: true },
        {
          entries: [userEntry("inactive-branch"), customEntry("active-branch")],
          leafId: "active-branch",
          initializes: true,
        },
      ];
      for (const testCase of cases) {
        const h = yield* harness(testCase);
        yield* h.start();
        expect(yield* h.preferenceExists()).toBe(testCase.initializes);
        expect(h.setModel).not.toHaveBeenCalled();
        yield* h.shutdown();
      }
    }),
  );

  it.effect("fails closed when startup cannot resolve the active session context", () =>
    Effect.gen(function* () {
      for (const sessionReadFailure of ["entries", "leaf"] as const) {
        const h = yield* harness({ sessionReadFailure });
        yield* h.start();
        expect(yield* h.preferenceExists()).toBe(false);
        expect(h.notify.mock.calls).toEqual([[expect.any(String), "warning"]]);
        yield* h.shutdown();
      }
    }),
  );

  it.effect("restores /new without querying a hostile session manager", () =>
    Effect.gen(function* () {
      const h = yield* harness({ sessionReadFailure: "both" });
      yield* h.seedRememberedPreference();

      yield* h.start("new");
      expect(h.getEntries).not.toHaveBeenCalled();
      expect(h.getLeafId).not.toHaveBeenCalled();
      expect(h.setModel).toHaveBeenCalledWith(h.remembered);
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps nonfresh starts available without querying hostile session managers", () =>
    Effect.gen(function* () {
      for (const reason of ["resume", "fork", "reload"] as const) {
        const h = yield* harness({ sessionReadFailure: "both" });
        yield* h.seedRememberedPreference();
        const saved = yield* h.readPreference();
        yield* h.start(reason);
        expect(h.model()).toEqual(h.initial);
        expect(h.thinking()).toBe("low");
        expect(yield* h.readPreference()).toEqual(saved);
        expect(h.getEntries).not.toHaveBeenCalled();
        expect(h.getLeafId).not.toHaveBeenCalled();
        expect(h.setModel).not.toHaveBeenCalled();

        h.select(h.alternate, "medium");
        yield* h.emitModel(h.alternate, h.initial);
        expect(yield* h.readPreference()).toMatchObject({
          provider: h.alternate.provider,
          model: h.alternate.id,
          thinkingLevel: "medium",
        });
        expect(h.notify).not.toHaveBeenCalled();
        yield* h.shutdown();
      }
    }),
  );

  it.effect("persists interactive model and thinking changes but ignores restore events", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();

      h.select(h.remembered, "medium");
      yield* h.emitModel(h.remembered, h.initial);
      expect(yield* h.readPreference()).toMatchObject({
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "medium",
      });

      h.select(h.remembered, "high");
      yield* h.emitThinking("high", "medium");
      expect((yield* h.readPreference()).thinkingLevel).toBe("high");

      h.select(h.alternate, "low");
      yield* h.emitModel(h.alternate, h.remembered, "restore");
      expect(yield* h.readPreference()).toMatchObject(h.rememberedPreference);
    }),
  );

  it.effect("ignores malformed thinking-level events", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      h.select(h.remembered, "high");

      yield* h.emitThinking("unexpected-level", "low");

      expect(yield* h.readPreference()).toMatchObject({
        provider: h.initial.provider,
        model: h.initial.id,
        thinkingLevel: "low",
      });
    }),
  );

  it.effect("keeps thinking events delayed past restoration idempotent", () =>
    Effect.gen(function* () {
      const h = yield* harness({ delayThinkingEvents: true });
      yield* h.seedRememberedPreference();
      yield* h.start();

      h.select(h.alternate, "medium");
      yield* h.emitModel(h.alternate, h.remembered);
      yield* h.flushThinkingEvents();

      expect(yield* h.readPreference()).toMatchObject({
        provider: h.alternate.provider,
        model: h.alternate.id,
        thinkingLevel: "medium",
      });
    }),
  );

  it.effect.each([
    ["setModel resolves false", { setModelDenied: true }, true],
    ["Pi's current model getter fails", { modelReadFailure: true }, true],
    ["a CLI preference is explicit", { explicitPreference: true }, false],
  ] as const)("keeps the preference and session state intact when %s", ([, options, warns]) =>
    Effect.gen(function* () {
      const h = yield* harness(options);
      yield* h.seedRememberedPreference();

      yield* h.start();
      expect(h.model()).toBe(h.initial);
      expect(h.thinking()).toBe("low");
      expect(h.setThinkingLevel).not.toHaveBeenCalled();
      expect(yield* h.readPreference()).toMatchObject(h.rememberedPreference);
      expect(h.notify.mock.calls).toEqual(warns ? [[expect.any(String), "warning"]] : []);
    }),
  );

  it.effect("retains an unavailable preference and fails open with one warning", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* writePreference(h.agentDirectory, h.cwd, {
        provider: "missing-provider",
        model: "missing-model",
        thinkingLevel: "high",
      });

      yield* h.start();
      expect(h.setModel).not.toHaveBeenCalled();
      expect(yield* h.readPreference()).toMatchObject({
        provider: "missing-provider",
        model: "missing-model",
      });
      expect(h.notify.mock.calls).toEqual([[expect.any(String), "warning"]]);
    }),
  );

  it.effect("ignores model and thinking events before startup and after shutdown", () =>
    Effect.gen(function* () {
      const h = yield* harness();

      h.select(h.remembered, "high");
      yield* h.emitModel(h.remembered, h.initial);
      yield* h.emitThinking("high", "low");
      expect(yield* h.preferenceExists()).toBe(false);
      expect(h.notify).not.toHaveBeenCalled();

      h.select(h.initial, "low");
      yield* h.start();
      yield* h.shutdown();
      const persisted = yield* h.readPreference();

      h.select(h.alternate, "high");
      yield* h.emitModel(h.alternate, h.initial);
      yield* h.emitThinking("high", "low");
      expect(yield* h.readPreference()).toEqual(persisted);
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("retries identity lookup after an earlier failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({
        prefix: "pi-directory-models-late-project-parent-",
      });
      const cwd = path.join(parent, "created-after-startup");
      const h = yield* harness({ cwd });

      yield* h.start();
      expect(h.notify).toHaveBeenCalledTimes(1);

      yield* fs.makeDirectory(cwd);
      h.select(h.remembered, "high");
      yield* h.emitModel(h.remembered, h.initial);

      expect(yield* h.readPreference()).toMatchObject(h.rememberedPreference);
      expect(h.notify).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("fails open and preserves malformed or foreign-cwd preference documents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const malformed = yield* harness();
      const malformedTarget = yield* preferencePath(malformed.agentDirectory, malformed.cwd);
      yield* fs.makeDirectory(path.dirname(malformedTarget), { recursive: true });
      yield* fs.writeFileString(malformedTarget, "{ not json");
      yield* malformed.start();
      expect(malformed.setModel).not.toHaveBeenCalled();
      expect(yield* fs.readFileString(malformedTarget)).toBe("{ not json");
      yield* malformed.shutdown();

      const foreign = yield* harness();
      const foreignTarget = yield* writePreference(
        foreign.agentDirectory,
        foreign.cwd,
        foreign.rememberedPreference,
        "/somewhere/else",
      );
      const document = yield* fs.readFileString(foreignTarget);
      yield* foreign.start();
      expect(foreign.setModel).not.toHaveBeenCalled();
      expect(yield* fs.readFileString(foreignTarget)).toBe(document);
      yield* foreign.shutdown();
    }),
  );

  it.effect("canonicalizes symlink aliases to the target directory preference", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = yield* fs.makeTempDirectoryScoped({ prefix: "pi-directory-models-target-" });
      const parent = yield* fs.makeTempDirectoryScoped({
        prefix: "pi-directory-models-link-parent-",
      });
      const alias = path.join(parent, "cern-alias");
      yield* fs.symlink(target, alias);
      const h = yield* harness({ cwd: alias });

      yield* h.start();
      expect((yield* readPreference(h.agentDirectory, target)).cwd).toBe(
        yield* fs.realPath(target),
      );
    }),
  );
});
