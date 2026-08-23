import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
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
import { preferenceFilename } from "../src/boundary/path-key.ts";
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
    readonly explicitModel?: boolean;
    readonly entries?: readonly { readonly type: string }[];
    readonly cwd?: string;
    readonly delayThinkingEvents?: boolean;
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
    const contextFixture = {
      cwd,
      get model() {
        return activeModel;
      },
      modelRegistry: {
        find(provider: string, id: string) {
          return available.get(`${provider}/${id}`);
        },
      },
      sessionManager: {
        buildContextEntries: () => [...(options.entries ?? [])],
      },
      ui: { notify },
    };
    // SAFETY: Tests invoke only the ExtensionContext members implemented by this fixture.
    ctx = contextFixture as typeof contextFixture & ExtensionContext;
    registerDirectoryModelsApplication(pi, () => options.explicitModel ?? false);

    const emit = <Event>(name: string, event: Event): Effect.Effect<void> =>
      Effect.promise(() => Promise.resolve(handlers.get(name)?.(event, ctx)).then(() => undefined));
    const start = (reason: "startup" | "new" | "resume" | "fork" | "reload" = "startup") =>
      emit("session_start", { type: "session_start", reason });
    const shutdown = () => emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    return {
      realCwd,
      cwd,
      agentDirectory,
      initial,
      remembered,
      alternate,
      available,
      notify,
      setModel,
      setThinkingLevel,
      start,
      shutdown,
      emit,
      select(next: Model, thinking: "low" | "medium" | "high" = thinkingLevel) {
        activeModel = next;
        thinkingLevel = thinking;
      },
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
      const path = yield* Path.Path;
      const h = yield* harness();
      yield* h.start();

      expect(path.basename(yield* preferencePath(h.agentDirectory, h.cwd))).toMatch(
        /^pi-directory-models-project-.*--[a-f0-9]{12}\.json$/,
      );
      expect(yield* readPreference(h.agentDirectory, h.cwd)).toMatchObject({
        cwd: yield* fs.realPath(h.cwd),
        provider: h.initial.provider,
        model: h.initial.id,
        thinkingLevel: "low",
      });
      yield* h.shutdown();
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
      yield* h.shutdown();
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
      expect(h.notify).not.toHaveBeenCalledWith(
        "Unable to save the directory model preference.",
        "warning",
      );
      yield* h.shutdown();
    });
  });

  it.effect("leaves explicit --model and resumed session choices alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const explicit = yield* harness({ explicitModel: true });
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

      for (const entry of [{ type: "message" }, { type: "custom_message" }]) {
        const resumed = yield* harness({ entries: [entry] });
        yield* resumed.start();
        expect(yield* fs.exists(yield* preferencePath(resumed.agentDirectory, resumed.cwd))).toBe(
          false,
        );
        expect(resumed.setModel).not.toHaveBeenCalled();
        yield* resumed.shutdown();
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
      yield* h.shutdown();
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
      yield* h.shutdown();
    }),
  );

  it.effect("suppresses thinking events delayed past restoration", () =>
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
      yield* h.shutdown();
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
      expect(h.notify).toHaveBeenCalledWith(
        "The remembered directory model is not available.",
        "warning",
      );
      yield* h.shutdown();
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
      yield* h.shutdown();
    }),
  );
});
