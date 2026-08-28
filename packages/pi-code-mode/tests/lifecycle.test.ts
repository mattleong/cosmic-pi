// Code Mode's Pi boundary owns preview preparation, registration currency, and snapshots.
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, vi } from "vitest";
import {
  registerCodeModeApplication,
  type CodeModeApplicationBoundaries,
} from "../src/application.ts";
import { CodeModeConfigStore } from "../src/config/store.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import {
  codeModeStateFixture,
  extensionApiFixture,
  extensionContextFixture,
  opaqueHostFixture,
} from "./support/host.ts";

// Raw Node builtin access for synchronous test scaffolding, mirroring pi-cosmic-core's
// platform boundary; the Effect FileSystem service does not expose these sync contracts.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = nodeFsModule;
const { join } = nodePathModule;

// Mutating the agent-directory slot is this suite's process-environment host boundary.
const processEnv: NodeJS.ProcessEnv = process.env;

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete processEnv.PI_CODING_AGENT_DIR;
});

const newDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
};

describe("code mode application lifecycle at the Pi boundary", () => {
  type Handler = ExtensionHandler<any, any>;
  type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
  type LifecycleEventFixture = { readonly reason: string };

  function applicationHarness(
    boundaryOverrides: Partial<CodeModeApplicationBoundaries> = {},
    initialActiveTools: string[] = [],
  ) {
    const agentDir = newDirectory("pi-code-mode-lc-agent-");
    processEnv.PI_CODING_AGENT_DIR = agentDir;
    const handlers = new Map<string, Handler>();
    const commands = new Map<string, CommandDefinition>();
    const notify = vi.fn();
    const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
    let activeTools = [...initialActiveTools];
    const pi = extensionApiFixture({
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerCommand(name: string, definition: CommandDefinition) {
        commands.set(name, definition);
      },
      registerTool,
      getActiveTools: () => [...activeTools],
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
      events: { emit: vi.fn(), on: vi.fn() },
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    registerCodeModeApplication(pi, {
      loadSettings: () => Promise.resolve(opaqueHostFixture({})),
      wrapTool: (tool) => tool,
      makeNestedDefinitions: () => ({}) as never,
      ...boundaryOverrides,
    });

    const makeContext = (cwd: string, signal?: AbortSignal, trusted = true) =>
      extensionContextFixture({
        cwd,
        mode: "rpc",
        hasUI: true,
        signal,
        ui: { notify, custom: vi.fn(), select: vi.fn(), input: vi.fn() },
        isProjectTrusted: vi.fn(() => trusted),
      });
    const invoke = (
      name: string,
      event: LifecycleEventFixture,
      ctx: ReturnType<typeof makeContext>,
    ) => Promise.resolve(handlers.get(name)?.(event, ctx)).then(() => undefined);
    return {
      agentDir,
      notify,
      registerTool,
      activeTools: () => [...activeTools],
      makeContext,
      start: (ctx: ReturnType<typeof makeContext>, reason = "startup") =>
        invoke("session_start", { reason }, ctx),
      shutdown: (ctx: ReturnType<typeof makeContext>, reason = "quit") =>
        invoke("session_shutdown", { reason }, ctx),
      command: (args: string, ctx: ReturnType<typeof makeContext>) =>
        Promise.resolve(commands.get("code-mode-settings")?.handler(args, ctx)).then(
          () => undefined,
        ),
    };
  }

  it.effect(
    "interrupts a pending preview load on replacement and registers only the replacement",
    () =>
      Effect.gen(function* () {
        const firstCwd = newDirectory("pi-code-mode-lc-cwd-");
        const secondCwd = newDirectory("pi-code-mode-lc-cwd-");
        const previewStarted = Deferred.makeUnsafe<void>();
        let firstSignal: AbortSignal | undefined;
        const makeNestedDefinitions = vi.fn(() => {
          // SAFETY: The registered tool is never executed in this lifecycle test.
          return {} as never;
        });
        const h = applicationHarness({
          loadSettings: (cwd, _trusted, signal) => {
            if (cwd !== firstCwd) return Promise.resolve(opaqueHostFixture({}));
            firstSignal = signal;
            void Deferred.doneUnsafe(previewStarted, Effect.void);
            return Promise.race([]);
          },
          makeNestedDefinitions,
        });
        const firstCtx = h.makeContext(firstCwd);
        const firstStart = h.start(firstCtx);
        yield* Deferred.await(previewStarted);

        const secondCtx = h.makeContext(secondCwd);
        const secondStart = h.start(secondCtx, "new");
        yield* Effect.promise(() => Promise.all([firstStart, secondStart]));

        expect(firstSignal?.aborted).toBe(true);
        expect(h.registerTool).toHaveBeenCalledTimes(1);
        expect(makeNestedDefinitions).toHaveBeenCalledTimes(1);
        expect(makeNestedDefinitions).toHaveBeenCalledWith(secondCwd);
        yield* Effect.promise(() => h.shutdown(secondCtx));
      }),
  );

  it.effect("interrupts a pending preview load on shutdown without registering", () =>
    Effect.gen(function* () {
      const previewStarted = Deferred.makeUnsafe<void>();
      let previewSignal: AbortSignal | undefined;
      const h = applicationHarness({
        loadSettings: (_cwd, _trusted, signal) => {
          previewSignal = signal;
          void Deferred.doneUnsafe(previewStarted, Effect.void);
          return Promise.race([]);
        },
      });
      const ctx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"));
      const starting = h.start(ctx);
      yield* Deferred.await(previewStarted);
      const shutdown = h.shutdown(ctx);
      yield* Effect.promise(() => Promise.all([starting, shutdown]));

      expect(previewSignal?.aborted).toBe(true);
      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.activeTools()).not.toContain("code_mode");
    }),
  );

  it.effect("uses preview defaults when preview settings fail", () =>
    Effect.gen(function* () {
      const h = applicationHarness({
        loadSettings: () => Promise.reject(new Error("preview settings unavailable")),
      });
      const ctx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"));
      yield* Effect.promise(() => h.start(ctx));
      expect(h.registerTool).toHaveBeenCalledTimes(1);
      yield* Effect.promise(() => h.shutdown(ctx));
    }),
  );

  it.effect("skips preview preparation and registration when unavailable or disabled", () =>
    Effect.gen(function* () {
      const untrustedLoad = vi.fn(() => Promise.resolve(opaqueHostFixture({})));
      const untrusted = applicationHarness({ loadSettings: untrustedLoad });
      const untrustedCtx = untrusted.makeContext(
        newDirectory("pi-code-mode-lc-cwd-"),
        undefined,
        false,
      );
      yield* Effect.promise(() => untrusted.start(untrustedCtx));
      expect(untrustedLoad).not.toHaveBeenCalled();
      expect(untrusted.registerTool).not.toHaveBeenCalled();
      yield* Effect.promise(() => untrusted.shutdown(untrustedCtx));

      const disabledLoad = vi.fn(() => Promise.resolve(opaqueHostFixture({})));
      const disabled = applicationHarness({ loadSettings: disabledLoad });
      const configDir = join(disabled.agentDir, "extensions");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "pi-code-mode.json"), '{"enabled":false}\n');
      const disabledCtx = disabled.makeContext(newDirectory("pi-code-mode-lc-cwd-"));
      yield* Effect.promise(() => disabled.start(disabledCtx));
      expect(disabledLoad).not.toHaveBeenCalled();
      expect(disabled.registerTool).not.toHaveBeenCalled();
      yield* Effect.promise(() => disabled.shutdown(disabledCtx));
    }),
  );

  it.effect("contains a throwing definition factory and leaves the tool inactive", () =>
    Effect.gen(function* () {
      const h = applicationHarness({
        makeNestedDefinitions: () => {
          throw new Error("definition factory failed");
        },
      });
      const ctx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"));
      yield* Effect.promise(() => h.start(ctx));

      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.activeTools()).not.toContain("code_mode");
      expect(h.notify.mock.calls.some((call) => call[1] === "warning")).toBe(true);
      yield* Effect.promise(() => h.shutdown(ctx));
    }),
  );

  it.effect("does not register when settings disable Code Mode during preview loading", () =>
    Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const previewStarted = Deferred.makeUnsafe<void>();
      const releasePreview = Deferred.makeUnsafe<void>();
      const h = applicationHarness({
        loadSettings: () => {
          void Deferred.doneUnsafe(previewStarted, Effect.void);
          return runPromise(Deferred.await(releasePreview)).then(() => opaqueHostFixture({}));
        },
      });
      const ctx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"), new AbortController().signal);
      const starting = h.start(ctx);
      yield* Deferred.await(previewStarted);

      yield* Effect.promise(() => h.command("global enabled false", ctx));
      yield* Deferred.succeed(releasePreview, undefined);
      yield* Effect.promise(() => starting);

      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.activeTools()).not.toContain("code_mode");
      yield* Effect.promise(() => h.shutdown(ctx));
    }),
  );

  it.effect("builds a Windows catalog when the native PowerShell definition is present", () =>
    Effect.gen(function* () {
      const h = applicationHarness({
        makeNestedDefinitions: () => opaqueHostFixture({ powershell: {} }),
      });
      const ctx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"));
      yield* Effect.promise(() => h.start(ctx));
      const registered = h.registerTool.mock.calls[0]?.[0];
      expect(registered?.description).toContain("Windows-only tools.pi.powershell");
      expect(registered?.description).toContain("tools.session.backgroundTask");
      yield* Effect.promise(() => h.shutdown(ctx));
    }),
  );

  it.effect("builds the catalog from state published while preview loading was pending", () =>
    Effect.gen(function* () {
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      const previewStarted = Deferred.makeUnsafe<void>();
      const releasePreview = Deferred.makeUnsafe<void>();
      const h = applicationHarness({
        loadSettings: () => {
          void Deferred.doneUnsafe(previewStarted, Effect.void);
          return runPromise(Deferred.await(releasePreview)).then(() => opaqueHostFixture({}));
        },
      });
      const ctx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"), new AbortController().signal);
      const starting = h.start(ctx);
      yield* Deferred.await(previewStarted);

      yield* Effect.promise(() => h.command("global catalogBudget 7", ctx));
      yield* Deferred.succeed(releasePreview, undefined);
      yield* Effect.promise(() => starting);

      const registered = h.registerTool.mock.calls[0]?.[0];
      const expected = buildCodeModeToolDefinition({
        catalogBudget: 7,
        includePowerShell: false,
        execute: () => Promise.reject(new Error("not executed")),
      });
      expect(registered?.description).toBe(expected.description);
      yield* Effect.promise(() => h.shutdown(ctx));
    }),
  );

  it.effect(
    "rejects a deactivated session's late publication until its replacement publishes",
    () =>
      Effect.gen(function* () {
        const firstCwd = newDirectory("pi-code-mode-lc-cwd-");
        const secondCwd = newDirectory("pi-code-mode-lc-cwd-");
        const commit = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();
        const nextStart = Deferred.makeUnsafe<void>();
        const publishNext = Deferred.makeUnsafe<void>();
        const initial = codeModeStateFixture({ catalogBudget: 2_000 });
        const stale = codeModeStateFixture({ catalogBudget: 7 });
        const replacement = codeModeStateFixture({ catalogBudget: 99 });
        let latePublicationAttempted = false;
        const h = applicationHarness({
          makeLayer: ({ cwd }, publish) => {
            const store = (state: typeof initial, setSetting = () => Effect.succeed(state)) =>
              CodeModeConfigStore.of({
                snapshot: () => state,
                setSetting,
                clearSetting: () => Effect.succeed(state),
              });
            if (cwd === secondCwd)
              return Layer.effect(
                CodeModeConfigStore,
                Deferred.succeed(nextStart, undefined).pipe(
                  Effect.andThen(Deferred.await(publishNext)),
                  Effect.andThen(
                    Effect.sync(() => {
                      publish(replacement);
                      return store(replacement);
                    }),
                  ),
                ),
              );
            const late = Deferred.succeed(commit, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  latePublicationAttempted = true;
                  publish(stale);
                  return stale;
                }),
              ),
            );
            return Layer.effect(
              CodeModeConfigStore,
              Effect.sync(() => {
                publish(initial);
                return store(initial, () => Effect.uninterruptible(late));
              }),
            );
          },
        });
        const firstCtx = h.makeContext(firstCwd);
        yield* Effect.promise(() => h.start(firstCtx));
        const oldWrite = h.command("global catalogBudget 7", firstCtx);
        yield* Deferred.await(commit);

        const secondCtx = h.makeContext(secondCwd);
        const replacing = h.start(secondCtx, "new");
        h.notify.mockClear();
        yield* Effect.promise(() => h.command("status", secondCtx));
        expect(h.notify.mock.calls.map((call) => call[1])).toEqual(["warning"]);

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(nextStart);
        expect(latePublicationAttempted).toBe(true);
        h.notify.mockClear();
        yield* Effect.promise(() => h.command("status", secondCtx));
        expect(h.notify.mock.calls.map((call) => call[1])).toEqual(["warning"]);

        yield* Deferred.succeed(publishNext, undefined);
        yield* Effect.promise(() => Promise.all([oldWrite, replacing]));
        h.notify.mockClear();
        yield* Effect.promise(() => h.command("status", secondCtx));
        expect(h.notify.mock.calls.map((call) => call[1])).toEqual(["info"]);
        expect(h.registerTool).toHaveBeenCalledTimes(2);
        yield* Effect.promise(() => h.shutdown(secondCtx));
      }),
  );

  it.effect("preserves unrelated active-tool order and duplicates during reconciliation", () =>
    Effect.gen(function* () {
      const h = applicationHarness({}, ["read", "read", "bash"]);
      const ctx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"));
      yield* Effect.promise(() => h.start(ctx));
      expect(h.activeTools()).toEqual(["read", "read", "bash", "code_mode"]);

      yield* Effect.promise(() => h.shutdown(ctx));
      expect(h.activeTools()).toEqual(["read", "read", "bash"]);
    }),
  );
});
