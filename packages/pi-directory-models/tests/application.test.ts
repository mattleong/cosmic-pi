import {
  buildSessionProjection,
  type ExtensionContext,
  type SessionEntry,
  type SessionStartEvent,
  type ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  extensionContextFixture,
  modelFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { registerDirectoryModelsApplication } from "../src/application.ts";
import { preferenceFilename } from "../src/config/path-key.ts";
import {
  DirectoryModelPreferenceSchema,
  directoryModelPreference,
  type DirectoryModelPreference,
} from "../src/config/schema.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

type Model = NonNullable<ExtensionContext["model"]>;

const PreferenceFromJson = Schema.fromJsonString(DirectoryModelPreferenceSchema);
const encodeJsonDocument = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

// A replaced document gets a fresh modification time, so a kept stamp shows no write happened.
const UNCHANGED_STAMP_SECONDS = 978_307_200;

type ThinkingLevel = ThinkingLevelSelectEvent["level"];

const model = (provider: string, id: string): Model =>
  modelFixture({ provider, id, reasoning: true });

const preferenceOf = (selected: Model, thinkingLevel: "low" | "medium" | "high") => ({
  provider: selected.provider,
  model: selected.id,
  thinkingLevel,
});

const settled = (emitted: Promise<unknown>) =>
  emitted.then(
    () => Effect.void,
    (cause: unknown) => Effect.die(cause),
  );

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

const writePreference = (
  agentDirectory: string,
  cwd: string,
  preference: Omit<DirectoryModelPreference, "cwd" | "version">,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = yield* preferencePath(agentDirectory, cwd);
    yield* fs.makeDirectory(path.join(agentDirectory, "pi-directory-models"), { recursive: true });
    const serialized = yield* Schema.encodeUnknownEffect(PreferenceFromJson)(
      directoryModelPreference(
        yield* fs.realPath(cwd),
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
    readonly thinkingReadFailure?: boolean;
    readonly setModelDenied?: boolean;
    readonly setModelSettlement?: Promise<void>;
    readonly onSetModel?: () => void;
    readonly retireDuringThinkingRestore?: boolean;
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
    const rememberedPreference = preferenceOf(remembered, "high");
    const alternate = model("xai", "grok-code");
    const available = new Map(
      Arr.map(
        [initial, remembered, alternate],
        (value) => [`${value.provider}/${value.id}`, value] as const,
      ),
    );
    let activeModel = initial;
    let thinkingLevel: "low" | "medium" | "high" = "low";
    const notify = vi.fn();
    const delayedThinkingEvents: ThinkingLevelSelectEvent[] = [];
    const thinkingEvents: Array<Promise<Effect.Effect<void>>> = [];
    const drainThinkingEvents = () =>
      Effect.promise(() => Promise.all(thinkingEvents.splice(0))).pipe(
        Effect.flatMap((events) => Effect.all(events, { discard: true })),
      );
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
      if (options.retireDuringThinkingRestore) {
        // The shutdown handler retires the session synchronously; runtime disposal follows later.
        thinkingEvents.push(settled(host.emit("session_shutdown", ctx)));
        throw new Error("thinking level failed after retirement");
      }
      const previousLevel = thinkingLevel;
      thinkingLevel = level;
      const event: ThinkingLevelSelectEvent = {
        type: "thinking_level_select",
        level,
        previousLevel,
      };
      if (options.delayThinkingEvents) delayedThinkingEvents.push(event);
      else thinkingEvents.push(settled(host.emit("thinking_level_select", ctx, event)));
    });
    const getThinkingLevel = () => {
      if (options.thinkingReadFailure) throw new Error("thinking level read failed");
      return thinkingLevel;
    };
    const host = recordingExtensionHost({}, { setModel, getThinkingLevel, setThinkingLevel });
    const getEntries = () => {
      if (options.sessionReadFailure === "entries" || options.sessionReadFailure === "both") {
        throw new Error("entries read failed");
      }
      return [...(options.entries ?? [])];
    };
    const getLeafId = () => {
      if (options.sessionReadFailure === "leaf" || options.sessionReadFailure === "both") {
        throw new Error("leaf read failed");
      }
      if (options.leafId !== undefined) return options.leafId;
      return options.entries?.at(-1)?.id ?? null;
    };
    const ctx = extensionContextFixture({
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
      sessionManager: {
        getEntries,
        getLeafId,
        buildSessionProjection: () => buildSessionProjection(getEntries(), getLeafId()),
      },
      ui: { notify },
    });
    registerDirectoryModelsApplication(host.pi, options.explicitPreference ?? false);

    const start = (reason: SessionStartEvent["reason"] = "startup") =>
      Effect.promise(() => host.emit("session_start", ctx, { type: "session_start", reason })).pipe(
        Effect.tap(drainThinkingEvents),
      );
    const shutdown = () => Effect.promise(() => host.emit("session_shutdown", ctx));
    yield* Effect.addFinalizer(() => drainThinkingEvents().pipe(Effect.ensuring(shutdown())));

    return {
      cwd,
      agentDirectory,
      initial,
      remembered,
      rememberedPreference,
      seedRememberedPreference: () => writePreference(agentDirectory, cwd, rememberedPreference),
      readPreference: () => readPreference(agentDirectory, cwd),
      preferenceExists: () => Effect.flatMap(preferencePath(agentDirectory, cwd), fs.exists),
      stampPreference: () =>
        Effect.flatMap(preferencePath(agentDirectory, cwd), (target) =>
          fs.utimes(target, UNCHANGED_STAMP_SECONDS, UNCHANGED_STAMP_SECONDS),
        ),
      preferenceModifiedAt: () =>
        preferencePath(agentDirectory, cwd).pipe(
          Effect.flatMap(fs.stat),
          Effect.map((info) =>
            Option.getOrUndefined(Option.map(info.mtime, (date) => date.getTime() / 1000)),
          ),
        ),
      alternate,
      notify,
      /** Notices at one level: the info notice after a restore is separate from any warning. */
      notices: (level: "info" | "warning") =>
        Arr.filter(notify.mock.calls, ([, shown]) => shown === level),
      setModel,
      setThinkingLevel,
      start,
      shutdown,
      emitModel: (selected: Model, previousModel: Model, source: "set" | "restore" = "set") =>
        Effect.promise(() =>
          host.emit("model_select", ctx, {
            type: "model_select",
            model: selected,
            previousModel,
            source,
          }),
        ),
      emitThinking: (level: ThinkingLevel, previousLevel: ThinkingLevel) =>
        Effect.promise(() =>
          host.emit("thinking_level_select", ctx, {
            type: "thinking_level_select",
            level,
            previousLevel,
          }),
        ),
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
        ...preferenceOf(h.initial, "low"),
      });
    }),
  );

  it.effect("restores model and thinking for fresh startup and /new", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.seedRememberedPreference();
      yield* h.stampPreference();

      yield* h.start();
      expect(h.setModel).toHaveBeenCalledWith(h.remembered);
      expect(h.thinking()).toBe("high");
      // Restoring what is already saved rewrites nothing.
      expect(yield* h.preferenceModifiedAt()).toBe(UNCHANGED_STAMP_SECONDS);
      // One info notice names what the restore put in use.
      expect(h.notices("info")).toEqual([
        [expect.stringContaining(`${h.remembered.provider}/${h.remembered.id}`), "info"],
      ]);
      expect(h.notices("warning")).toEqual([]);

      h.select(h.initial, "low");
      yield* h.start("new");
      expect(h.setModel).toHaveBeenLastCalledWith(h.remembered);
      expect(h.thinking()).toBe("high");
    }),
  );

  it.effect("restores silently when the session already uses the saved preference", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* writePreference(h.agentDirectory, h.cwd, preferenceOf(h.initial, "low"));

      yield* h.start();
      expect(h.setModel).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
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
      expect(h.notices("warning")).toEqual([]);
    }).pipe(Effect.ensuring(Deferred.succeed(settlement, undefined)));
  });

  it.effect("does not warn on a session retired before its runtime is disposed", () =>
    Effect.gen(function* () {
      const h = yield* harness({ retireDuringThinkingRestore: true });
      yield* h.seedRememberedPreference();

      yield* h.start();
      expect(h.setThinkingLevel).toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

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
        expect(h.setModel).not.toHaveBeenCalled();

        h.select(h.alternate, "medium");
        yield* h.emitModel(h.alternate, h.initial);
        expect(yield* h.readPreference()).toMatchObject(preferenceOf(h.alternate, "medium"));
        expect(h.notify).not.toHaveBeenCalled();
        yield* h.shutdown();
      }
    }),
  );

  it.effect(
    "persists interactive model and thinking changes once per final state and ignores restore events",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start();

        h.select(h.remembered, "medium");
        yield* h.emitModel(h.remembered, h.initial);
        expect(yield* h.readPreference()).toMatchObject(preferenceOf(h.remembered, "medium"));
        // A second event for the same final selection writes nothing.
        yield* h.stampPreference();
        yield* h.emitThinking("medium", "low");
        expect(yield* h.preferenceModifiedAt()).toBe(UNCHANGED_STAMP_SECONDS);

        h.select(h.remembered, "high");
        yield* h.emitThinking("high", "medium");
        expect((yield* h.readPreference()).thinkingLevel).toBe("high");

        h.select(h.alternate, "low");
        yield* h.emitModel(h.alternate, h.remembered, "restore");
        expect(yield* h.readPreference()).toMatchObject(h.rememberedPreference);
        expect(h.notify).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "replaces a preference another process saved when this session's selection repeats",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.start();

        h.select(h.remembered, "medium");
        yield* h.emitModel(h.remembered, h.initial);
        yield* writePreference(h.agentDirectory, h.cwd, preferenceOf(h.alternate, "low"));

        yield* h.emitThinking("medium", "low");
        expect(yield* h.readPreference()).toMatchObject(preferenceOf(h.remembered, "medium"));
        expect(h.notify).not.toHaveBeenCalled();
      }),
  );

  it.effect("warns once and saves nothing when Pi's thinking level cannot be read", () =>
    Effect.gen(function* () {
      const h = yield* harness({ thinkingReadFailure: true });
      // A resumed session restores nothing, so only the saves below read the thinking level.
      yield* h.start("resume");
      expect(h.notify).not.toHaveBeenCalled();

      h.select(h.remembered);
      yield* h.emitModel(h.remembered, h.initial);
      h.select(h.alternate);
      yield* h.emitModel(h.alternate, h.remembered);

      expect(h.notify.mock.calls).toEqual([[expect.stringContaining("/thinking"), "warning"]]);
      expect(yield* h.preferenceExists()).toBe(false);
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

      expect(yield* h.readPreference()).toMatchObject(preferenceOf(h.alternate, "medium"));
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
      // The warning names the saved model, so the user knows what to sign in to or replace.
      expect(h.notify.mock.calls).toEqual([
        [expect.stringContaining("missing-provider/missing-model"), "warning"],
      ]);
    }),
  );

  it.effect("restores a saved model whose thinking level is invalid and warns once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* harness();
      const target = yield* h.seedRememberedPreference();
      yield* fs.writeFileString(
        target,
        yield* encodeJsonDocument({
          version: 1,
          cwd: yield* fs.realPath(h.cwd),
          provider: h.remembered.provider,
          model: h.remembered.id,
          thinkingLevel: "High",
        }),
      );

      yield* h.start();
      expect(h.setModel).toHaveBeenCalledWith(h.remembered);
      expect(h.setThinkingLevel).not.toHaveBeenCalled();
      expect(h.thinking()).toBe("low");
      expect(h.notices("warning")).toEqual([[expect.any(String), "warning"]]);
      expect(yield* h.readPreference()).toMatchObject(preferenceOf(h.remembered, "low"));
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

  it.effect("fails open and preserves malformed, incomplete, or foreign-cwd documents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      type Saved = ReturnType<typeof preferenceOf>;
      const documents = [
        () => Effect.succeed("{ not json"),
        ({ provider, thinkingLevel }: Saved, cwd: string) =>
          encodeJsonDocument({ version: 1, cwd, provider, thinkingLevel }),
        (saved: Saved) => encodeJsonDocument({ version: 1, ...saved, cwd: "/somewhere/else" }),
      ];
      for (const document of documents) {
        const h = yield* harness();
        const target = yield* h.seedRememberedPreference();
        const saved = yield* document(h.rememberedPreference, yield* fs.realPath(h.cwd));
        yield* fs.writeFileString(target, saved);

        yield* h.start();
        expect(h.setModel).not.toHaveBeenCalled();
        expect(h.thinking()).toBe("low");
        expect(h.notify.mock.calls).toEqual([[expect.any(String), "warning"]]);
        expect(yield* fs.readFileString(target)).toBe(saved);
        yield* h.shutdown();
      }
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
