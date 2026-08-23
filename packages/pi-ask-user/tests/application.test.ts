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
import type { AskUserRequest } from "../src/tools/schema.ts";

type Handler = ExtensionHandler<any, any>;
interface CapturedToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly details: AskUserOutcome;
}
interface CapturedTool {
  readonly execute: (
    id: string,
    input: AskUserRequest,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<CapturedToolResult>;
}
afterEach(() => {
  vi.unstubAllEnvs();
});

const deferred = () => {
  const handle = Deferred.makeUnsafe<void>();
  return {
    promise: Effect.runPromise(Deferred.await(handle)),
    resolve: () => {
      Effect.runSync(Deferred.succeed(handle, void 0));
    },
  };
};

const harness = (
  loadPreviewSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
  ) => Promise<void>,
  startupEffect: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-application-" });
    const agentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-agent-" });
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory));
    const handlers = new Map<string, Handler>();
    let tool: CapturedTool | undefined;
    const fixture = {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerCommand: vi.fn(),
      registerTool: vi.fn((definition: CapturedTool) => {
        tool = definition;
      }),
    };
    // SAFETY: The application uses only the ExtensionAPI methods supplied by this lifecycle fixture.
    const pi = fixture as typeof fixture & ExtensionAPI;
    askUserWithDependencies(pi, { loadPreviewSettings, startupEffect });
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
      get tool() {
        return tool;
      },
    };
  });

layer(nodeFilePlatformLayer)("ask-user session admission", (it) => {
  it.effect("loads preview settings before initializing the session runtime", () =>
    Effect.gen(function* () {
      let loaded = false;
      let initialized = 0;
      const h = yield* harness(
        () =>
          Promise.resolve().then(() => {
            loaded = true;
          }),
        Effect.sync(() => {
          expect(loaded).toBe(true);
          initialized += 1;
        }),
      );

      yield* Effect.promise(() => h.emit("session_start"));
      expect(initialized).toBe(1);
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );

  it.effect("does not let an interrupted settings load initialize a replacement session", () =>
    Effect.gen(function* () {
      const first = deferred();
      let loads = 0;
      let initialized = 0;
      const signals: AbortSignal[] = [];
      const h = yield* harness(
        (_cwd, _projectTrusted, signal) => {
          loads += 1;
          if (signal) signals.push(signal);
          return loads === 1 ? first.promise : Promise.resolve();
        },
        Effect.sync(() => {
          initialized += 1;
        }),
      );

      const staleStart = h.emit("session_start");
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(loads).toBe(1);
        }),
      );
      const currentStart = h.emit("session_start");
      yield* Effect.promise(() => Promise.all([staleStart, currentStart]));

      expect(loads).toBe(2);
      expect(initialized).toBe(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      first.resolve();
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );

  it.effect("rejects a stale tool call while replacement startup is pending", () =>
    Effect.gen(function* () {
      const replacement = deferred();
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
        expect(
          tool.execute(
            "call",
            {
              questions: [
                {
                  key: "choice",
                  title: "Choice",
                  prompt: "Choose.",
                  mode: "single",
                  choices: [
                    { value: "a", label: "A", description: "Choose A." },
                    { value: "b", label: "B", description: "Choose B." },
                  ],
                },
              ],
            },
            undefined,
            undefined,
            h.ctx,
          ),
        ).rejects.toMatchObject({ _tag: "AskUserRuntimeClosedError" }),
      );

      replacement.resolve();
      yield* Effect.promise(() => replacing);
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );
});
