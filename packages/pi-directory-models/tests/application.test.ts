import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
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

type Handler = ExtensionHandler<any, any>;
type Model = NonNullable<ExtensionContext["model"]>;

const PreferenceFromJson = Schema.fromJsonString(DirectoryModelPreferenceSchema);

function model(provider: string, id: string): Model {
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  return { provider, id, reasoning: true } as Model;
}

const entryBase = (id: string, parentId: string | null = null) => ({
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const userEntry = (id: string, parentId: string | null = null): SessionEntry => ({
  ...entryBase(id, parentId),
  type: "message",
  message: { role: "user", content: "hello", timestamp: 0 },
});

const customMessageEntry = (id: string, parentId: string | null = null): SessionEntry => ({
  ...entryBase(id, parentId),
  type: "custom_message",
  customType: "test",
  content: "context",
  display: false,
});

const compactionEntry = (id: string, parentId: string | null = null): SessionEntry => ({
  ...entryBase(id, parentId),
  type: "compaction",
  summary: "earlier conversation",
  firstKeptEntryId: id,
  tokensBefore: 100,
});

const branchSummaryEntry = (id: string, parentId: string | null = null): SessionEntry => ({
  ...entryBase(id, parentId),
  type: "branch_summary",
  fromId: parentId ?? id,
  summary: "earlier branch",
});

const customEntry = (id: string, parentId: string | null = null): SessionEntry => ({
  ...entryBase(id, parentId),
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
    return yield* Schema.decodeUnknownEffect(PreferenceFromJson)(serialized);
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
    const canonical = yield* fs.realPath(cwd);
    const serialized = yield* Schema.encodeUnknownEffect(PreferenceFromJson)(
      makeDirectoryModelPreference(
        canonical,
        preference.provider,
        preference.model,
        preference.thinkingLevel,
      ),
    );
    yield* fs.writeFileString(target, `${serialized}\n`);
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
    const alternate = model("xai", "grok-code");
    const available = new Map(
      [initial, remembered, alternate].map((value) => [`${value.provider}/${value.id}`, value]),
    );
    let activeModel = initial;
    let thinkingLevel: "low" | "medium" | "high" = "low";
    const handlers = new Map<string, Handler>();
    const notify = vi.fn();
    let ctx!: ExtensionContext;
    const delayedThinkingEvents: unknown[] = [];
    const setModel = vi.fn(
      (next: Model): Promise<boolean> =>
        Promise.resolve(options.setModelSettlement).then(() => {
          if (options.setModelDenied) return false;
          const previousModel = activeModel;
          activeModel = next;
          return Promise.resolve(
            handlers.get("model_select")?.(
              { type: "model_select", model: next, previousModel, source: "set" },
              ctx,
            ),
          ).then(() => true);
        }),
    );
    const setThinkingLevel = vi.fn((level: typeof thinkingLevel) => {
      const previousLevel = thinkingLevel;
      thinkingLevel = level;
      const event = { type: "thinking_level_select", level, previousLevel };
      if (options.delayThinkingEvents) delayedThinkingEvents.push(event);
      else void handlers.get("thinking_level_select")?.(event, ctx);
    });
    const piFixture = {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      setModel,
      getThinkingLevel: () => thinkingLevel,
      setThinkingLevel,
    };
    // SAFETY: Tests invoke only the ExtensionAPI members implemented by this fixture.
    const pi = piFixture as typeof piFixture & ExtensionAPI;
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
    const contextFixture = {
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
    };
    // SAFETY: Tests invoke only the ExtensionContext members implemented by this fixture.
    ctx = contextFixture as typeof contextFixture & ExtensionContext;
    registerDirectoryModelsApplication(pi, options.explicitPreference ?? false);

    const emit = <Event>(name: string, event: Event): Effect.Effect<void> =>
      Effect.promise(() => Promise.resolve(handlers.get(name)?.(event, ctx)).then(() => undefined));
    const start = (reason: "startup" | "new" | "resume" | "fork" | "reload" = "startup") =>
      emit("session_start", { type: "session_start", reason });
    const shutdown = () => emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    yield* Effect.addFinalizer(() => shutdown());

    return {
      cwd,
      agentDirectory,
      initial,
      remembered,
      alternate,
      notify,
      getEntries,
      getLeafId,
      setModel,
      setThinkingLevel,
      start,
      shutdown,
      emit,
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
            (event) =>
              Effect.promise(() =>
                Promise.resolve(handlers.get("thinking_level_select")?.(event, ctx)),
              ),
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

      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
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
      yield* writePreference(h.agentDirectory, h.cwd, {
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });

      yield* h.start();
      expect(h.setModel).toHaveBeenCalledWith(h.remembered);
      expect(h.setThinkingLevel).toHaveBeenCalledWith("high");
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
      const h = yield* harness({ setModelSettlement: settlementPromise });
      yield* writePreference(h.agentDirectory, h.cwd, {
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });

      const first = yield* h.start().pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(h.setModel).toHaveBeenCalledTimes(1);
        }),
      );
      const successorSettled = yield* Deferred.make<void>();
      const successor = yield* h
        .start("new")
        .pipe(
          Effect.ensuring(Deferred.succeed(successorSettled, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      yield* Effect.promise(() => Promise.resolve());

      expect(yield* Deferred.isDone(successorSettled)).toBe(false);
      expect(h.setModel).toHaveBeenCalledTimes(1);

      yield* Deferred.succeed(settlement, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(successor);
      expect(h.setModel).toHaveBeenCalledTimes(1);
      expect(h.thinking()).toBe("high");
      expect(h.notify).not.toHaveBeenCalled();
    });
  });

  it.effect("leaves explicit CLI preferences and resumed session choices alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const explicit = yield* harness({ explicitPreference: true });
      yield* explicit.start();
      expect(yield* fs.exists(yield* preferencePath(explicit.agentDirectory, explicit.cwd))).toBe(
        false,
      );
      expect(explicit.setModel).not.toHaveBeenCalled();
      yield* explicit.start("new");
      expect(yield* fs.exists(yield* preferencePath(explicit.agentDirectory, explicit.cwd))).toBe(
        false,
      );
      yield* explicit.shutdown();

      for (const entries of [[userEntry("user")], [customMessageEntry("custom-message")]]) {
        const resumed = yield* harness({ entries });
        yield* resumed.start();
        expect(yield* fs.exists(yield* preferencePath(resumed.agentDirectory, resumed.cwd))).toBe(
          false,
        );
        expect(resumed.setModel).not.toHaveBeenCalled();
        yield* resumed.shutdown();
      }
    }),
  );

  it.effect("uses Pi's resolved session context to classify startup freshness", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cases: ReadonlyArray<{
        entries: readonly SessionEntry[];
        leafId?: string;
        initializes: boolean;
      }> = [
        { entries: [compactionEntry("compaction")], initializes: false },
        { entries: [branchSummaryEntry("branch-summary")], initializes: false },
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
        expect(yield* fs.exists(yield* preferencePath(h.agentDirectory, h.cwd))).toBe(
          testCase.initializes,
        );
        yield* h.shutdown();
      }
    }),
  );

  it.effect("fails closed when startup cannot resolve the active session context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const sessionReadFailure of ["entries", "leaf"] as const) {
        const h = yield* harness({ sessionReadFailure });
        yield* h.start();
        expect(yield* fs.exists(yield* preferencePath(h.agentDirectory, h.cwd))).toBe(false);
        expect(h.notify).toHaveBeenCalledTimes(1);
        expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
        yield* h.shutdown();
      }
    }),
  );

  it.effect("restores /new without querying a hostile session manager", () =>
    Effect.gen(function* () {
      const h = yield* harness({ sessionReadFailure: "both" });
      yield* writePreference(h.agentDirectory, h.cwd, {
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });

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
        yield* h.start(reason);
        expect(h.getEntries).not.toHaveBeenCalled();
        expect(h.getLeafId).not.toHaveBeenCalled();
        expect(h.setModel).not.toHaveBeenCalled();

        h.select(h.remembered, "high");
        yield* h.emit("model_select", {
          type: "model_select",
          model: h.remembered,
          previousModel: h.initial,
          source: "set",
        });
        expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
          provider: h.remembered.provider,
          model: h.remembered.id,
          thinkingLevel: "high",
        });
        expect(h.notify).not.toHaveBeenCalled();
        yield* h.shutdown();
      }
    }),
  );

  it.effect("preserves resume, fork, and reload event models", () =>
    Effect.gen(function* () {
      for (const reason of ["resume", "fork", "reload"] as const) {
        const h = yield* harness();
        yield* writePreference(h.agentDirectory, h.cwd, {
          provider: h.remembered.provider,
          model: h.remembered.id,
          thinkingLevel: "high",
        });
        yield* h.start(reason);
        expect(h.setModel).not.toHaveBeenCalled();
        yield* h.shutdown();
      }
    }),
  );

  it.effect("persists interactive model and thinking changes but ignores restore events", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();

      h.select(h.remembered, "medium");
      yield* h.emit("model_select", {
        type: "model_select",
        model: h.remembered,
        previousModel: h.initial,
        source: "set",
      });
      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "medium",
      });

      h.select(h.remembered, "high");
      yield* h.emit("thinking_level_select", {
        type: "thinking_level_select",
        level: "high",
        previousLevel: "medium",
      });
      expect((yield* readPreference(h.agentDirectory, h.cwd)).thinkingLevel).toBe("high");

      h.select(h.alternate, "low");
      yield* h.emit("model_select", {
        type: "model_select",
        model: h.alternate,
        previousModel: h.remembered,
        source: "restore",
      });
      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });
    }),
  );

  it.effect("ignores malformed thinking-level events", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      h.select(h.remembered, "high");

      yield* h.emit("thinking_level_select", {
        type: "thinking_level_select",
        level: "unexpected-level",
        previousLevel: "low",
      });

      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        provider: h.initial.provider,
        model: h.initial.id,
        thinkingLevel: "low",
      });
    }),
  );

  it.effect("keeps thinking events delayed past restoration idempotent", () =>
    Effect.gen(function* () {
      const h = yield* harness({ delayThinkingEvents: true });
      yield* writePreference(h.agentDirectory, h.cwd, {
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });
      yield* h.start();

      h.select(h.alternate, "medium");
      yield* h.emit("model_select", {
        type: "model_select",
        model: h.alternate,
        previousModel: h.remembered,
        source: "set",
      });
      yield* h.flushThinkingEvents();

      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        provider: h.alternate.provider,
        model: h.alternate.id,
        thinkingLevel: "medium",
      });
    }),
  );

  it.effect("keeps the preference and session state intact when setModel resolves false", () =>
    Effect.gen(function* () {
      const h = yield* harness({ setModelDenied: true });
      yield* writePreference(h.agentDirectory, h.cwd, {
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });

      yield* h.start();
      expect(h.model()).toBe(h.initial);
      expect(h.thinking()).toBe("low");
      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("retains the preference when Pi's current model getter fails", () =>
    Effect.gen(function* () {
      const h = yield* harness({ modelReadFailure: true });
      yield* writePreference(h.agentDirectory, h.cwd, {
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });

      yield* h.start();
      expect(h.setModel).not.toHaveBeenCalled();
      expect(h.setThinkingLevel).not.toHaveBeenCalled();
      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
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
      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        provider: "missing-provider",
        model: "missing-model",
      });
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("ignores model and thinking events before startup and after shutdown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const h = yield* harness();

      h.select(h.remembered, "high");
      yield* h.emit("model_select", {
        type: "model_select",
        model: h.remembered,
        previousModel: h.initial,
        source: "set",
      });
      yield* h.emit("thinking_level_select", {
        type: "thinking_level_select",
        level: "high",
        previousLevel: "low",
      });
      expect(yield* fs.exists(yield* preferencePath(h.agentDirectory, h.cwd))).toBe(false);
      expect(h.notify).not.toHaveBeenCalled();

      h.select(h.initial, "low");
      yield* h.start();
      yield* h.shutdown();
      const persisted = yield* readPreference(h.agentDirectory, h.cwd);

      h.select(h.alternate, "high");
      yield* h.emit("model_select", {
        type: "model_select",
        model: h.alternate,
        previousModel: h.initial,
        source: "set",
      });
      yield* h.emit("thinking_level_select", {
        type: "thinking_level_select",
        level: "high",
        previousLevel: "low",
      });
      expect(yield* readPreference(h.agentDirectory, h.cwd)).toEqual(persisted);
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
      yield* h.emit("model_select", {
        type: "model_select",
        model: h.remembered,
        previousModel: h.initial,
        source: "set",
      });

      expect(yield* readPreference(h.agentDirectory, cwd)).toMatchObject({
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });
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
      const foreignTarget = yield* preferencePath(foreign.agentDirectory, foreign.cwd);
      yield* fs.makeDirectory(path.dirname(foreignTarget), { recursive: true });
      const document = yield* Schema.encodeUnknownEffect(PreferenceFromJson)(
        makeDirectoryModelPreference(
          "/somewhere/else",
          foreign.remembered.provider,
          foreign.remembered.id,
          "high",
        ),
      );
      yield* fs.writeFileString(foreignTarget, document);
      yield* foreign.start();
      expect(foreign.setModel).not.toHaveBeenCalled();
      expect(yield* fs.readFileString(foreignTarget)).toBe(document);
      yield* foreign.shutdown();
    }),
  );

  it.effect("suppresses the atomic restore when a CLI preference is explicit", () =>
    Effect.gen(function* () {
      const h = yield* harness({ explicitPreference: true });
      yield* writePreference(h.agentDirectory, h.cwd, {
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });

      yield* h.start();
      expect(h.setModel).not.toHaveBeenCalled();
      expect(h.setThinkingLevel).not.toHaveBeenCalled();
      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });
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
      expect(yield* fs.exists(yield* preferencePath(h.agentDirectory, alias))).toBe(true);
    }),
  );
});
