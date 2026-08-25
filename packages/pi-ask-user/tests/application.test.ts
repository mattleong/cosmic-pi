import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, expect, vi } from "vitest";
import { askUserWithDependencies } from "../src/application.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

type Handler = ExtensionHandler<any, any>;
interface CapturedTool {
  readonly execute: (
    id: string,
    input: AskUserRequest,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: AskUserOutcome;
  }>;
}
interface CapturedCommand {
  readonly handler: (args: string, ctx: ExtensionContext) => void | Promise<void>;
}

afterEach(() => vi.unstubAllEnvs());

const controlled = () => {
  const handle = Deferred.makeUnsafe<void>();
  return {
    promise: Effect.runPromise(Deferred.await(handle)),
    resolve: () => {
      Effect.runSync(Deferred.succeed(handle, undefined));
    },
  };
};

const harness = (
  loadPreviewSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
  ) => Promise<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-application-" });
    const agentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-agent-" });
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory));
    const handlers = new Map<string, Handler>();
    let command: CapturedCommand | undefined;
    let tool: CapturedTool | undefined;
    const fixture = {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerCommand: vi.fn((name: string, definition: CapturedCommand) => {
        if (name === "ask-user") command = definition;
      }),
      registerTool: vi.fn((definition: CapturedTool) => {
        tool = definition;
      }),
    };
    // SAFETY: The application uses only the ExtensionAPI methods supplied by this lifecycle fixture.
    const pi = fixture as typeof fixture & ExtensionAPI;
    askUserWithDependencies(pi, loadPreviewSettings);
    const contextFixture = {
      cwd,
      hasUI: true,
      mode: "rpc",
      ui: { notify: vi.fn() },
      isProjectTrusted: () => true,
    };
    // SAFETY: The startup path reads only the context fields supplied by this fixture.
    const ctx = contextFixture as typeof contextFixture & ExtensionContext;
    const emit = (name: string) => Promise.resolve(handlers.get(name)?.({}, ctx));
    return {
      ctx,
      emit,
      fixture,
      get command() {
        return command;
      },
      get tool() {
        return tool;
      },
    };
  });

const request: AskUserRequest = {
  questions: [
    {
      key: "choice",
      title: "Choice",
      prompt: "Choose.",
      mode: "single",
      choices: [{ value: "a", label: "A", description: "Choose A." }],
    },
  ],
};

layer(nodeFilePlatformLayer)("ask-user session admission", (it) => {
  it.effect("defers tool registration until preview settings resolve", () =>
    Effect.gen(function* () {
      const preview = controlled();
      let loadSignal: AbortSignal | undefined;
      const h = yield* harness((_cwd, _projectTrusted, signal) => {
        loadSignal = signal;
        return preview.promise;
      });

      const starting = h.emit("session_start");
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(loadSignal).toBeInstanceOf(AbortSignal);
        }),
      );
      expect(loadSignal?.aborted).toBe(false);
      expect(h.fixture.registerTool).not.toHaveBeenCalled();
      expect(h.tool).toBeUndefined();

      preview.resolve();
      yield* Effect.promise(() => starting);
      expect(h.fixture.registerTool).toHaveBeenCalledOnce();
      expect(h.tool).toBeDefined();
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );

  it.effect("rejects a stale tool call while replacement startup is pending", () =>
    Effect.gen(function* () {
      const replacement = controlled();
      let loads = 0;
      const h = yield* harness(() => {
        loads += 1;
        return loads === 1 ? Promise.resolve() : replacement.promise;
      });
      yield* Effect.promise(() => h.emit("session_start"));

      const tool = h.tool;
      if (!tool) throw new Error("ask_user was not activated for the first session.");

      const replacing = h.emit("session_start");
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(loads).toBe(2);
        }),
      );
      yield* Effect.promise(() =>
        expect(tool.execute("call", request, undefined, undefined, h.ctx)).rejects.toMatchObject({
          _tag: "AskUserRuntimeClosedError",
        }),
      );

      replacement.resolve();
      yield* Effect.promise(() => replacing);
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );

  it.effect("activates past a rejected loader and contains a throwing inactive notification", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => Promise.reject(new Error("preview unavailable")));
      yield* Effect.promise(() => h.emit("session_start"));
      expect(h.fixture.registerTool).toHaveBeenCalledOnce();
      const command = h.command;
      if (!command) throw new Error("The ask-user command was not registered.");
      const notify = vi.fn(() => {
        throw new Error("stale UI");
      });
      // SAFETY: The captured handler reads only the notify field supplied here.
      yield* Effect.promise(() =>
        Promise.resolve(command.handler("", { ui: { notify } } as never)),
      );
      expect(notify).toHaveBeenCalledOnce();
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );
});
