// Promise assertions characterize the Pi lifecycle boundary.
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import {
  registerBackgroundTaskApplication,
  type BackgroundTaskApplicationBoundaries,
} from "../src/application.ts";

type Handler = ExtensionHandler<any, any>;

interface CapturedBackgroundTool {
  readonly name: string;
  readonly execute: (
    id: string,
    input: { readonly action: "list" },
    signal: AbortSignal,
    onUpdate: undefined,
    context: ExtensionContext,
  ) => Promise<object>;
}

const deferred = <A>() => {
  const gate = Deferred.makeUnsafe<A>();
  return {
    promise: Effect.runPromise(Deferred.await(gate)),
    resolve: (value: A) => void Deferred.doneUnsafe(gate, Effect.succeed(value)),
  };
};

const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext => {
  // SAFETY: Each test invokes only the ExtensionContext members explicitly implemented here.
  return fixture as Fixture & ExtensionContext;
};

const context = (cwd: string): ExtensionContext =>
  extensionContextFixture({
    cwd,
    signal: undefined,
    isProjectTrusted: () => false,
    hasUI: false,
    mode: "rpc",
  });

const harness = (loadSettings: BackgroundTaskApplicationBoundaries["loadSettings"]) => {
  const handlers = new Map<string, Handler>();
  const tools: CapturedBackgroundTool[] = [];
  const registerTool = vi.fn((tool: CapturedBackgroundTool) => tools.push(tool));
  const fixture = {
    events: undefined,
    registerCommand: vi.fn(),
    registerTool,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  };
  // SAFETY: Each test invokes only the ExtensionAPI members explicitly implemented above.
  registerBackgroundTaskApplication(fixture as typeof fixture & ExtensionAPI, {
    loadSettings,
  });
  return {
    tools,
    registerTool,
    emit: (name: "session_start" | "turn_end" | "session_shutdown", ctx: ExtensionContext) =>
      Promise.resolve(handlers.get(name)?.({}, ctx)),
  };
};

describe("background-task Pi lifecycle", () => {
  it.effect("skips superseded settings loads so only the latest generation activates", () =>
    Effect.gen(function* () {
      const settings = deferred<void>();
      const loads: Array<readonly [string, boolean]> = [];
      const app = harness((cwd, trusted) => {
        loads.push([cwd, trusted]);
        return settings.promise;
      });

      const firstStart = app.emit("session_start", context(`${process.cwd()}/first`));
      const secondContext = context(`${process.cwd()}/second`);
      const secondStart = app.emit("session_start", secondContext);

      settings.resolve();
      yield* Effect.promise(() => Promise.all([firstStart, secondStart]));
      expect(app.tools.map((tool) => tool.name)).toEqual(["background_task"]);
      // The superseded first start never reaches the settings boundary.
      expect(loads).toEqual([[`${process.cwd()}/second`, false]]);
      yield* Effect.promise(() => app.emit("session_shutdown", secondContext));
    }),
  );

  it.effect("ignores turn_end while the runtime slot is inactive", () =>
    Effect.gen(function* () {
      const settings = deferred<void>();
      const setStatus = vi.fn();
      const app = harness(() => settings.promise);
      const ctx = extensionContextFixture({
        ...context(process.cwd()),
        hasUI: true,
        mode: "tui",
        ui: { setStatus },
      });

      const starting = app.emit("session_start", ctx);
      yield* Effect.promise(() => app.emit("turn_end", ctx));
      expect(setStatus).not.toHaveBeenCalled();

      settings.resolve();
      yield* Effect.promise(() => starting);
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.effect("rejects a stale tool call typed while replacement settings are still loading", () =>
    Effect.gen(function* () {
      const entered = deferred<void>();
      const replacement = deferred<void>();
      let loadCount = 0;
      const app = harness(() => {
        if (++loadCount === 1) return Promise.resolve();
        entered.resolve();
        return replacement.promise;
      });
      const ctx = context(process.cwd());
      yield* Effect.promise(() => app.emit("session_start", ctx));
      const tool = app.tools[0];
      if (!tool) throw new Error("background tool registration was not captured");

      const replacing = app.emit("session_start", ctx);
      // The replacement loader has signalled entry and stays blocked: the prior runtime is
      // already deactivated and the next one is not yet active, so the activation-1 tool
      // must fail typed instead of reaching the unactivated replacement runtime.
      yield* Effect.promise(() => entered.promise);
      yield* Effect.promise(() =>
        expect(
          tool.execute(
            "replacement-check",
            { action: "list" },
            new AbortController().signal,
            undefined,
            ctx,
          ),
        ).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
      );

      replacement.resolve();
      yield* Effect.promise(() => replacing);
      // Tool activation still happens once settings resolve for the replacement generation.
      expect(app.tools.map((tool) => tool.name)).toEqual(["background_task", "background_task"]);
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.effect("invalidates pending settings preparation when the captured session aborts", () =>
    Effect.gen(function* () {
      const settings = deferred<void>();
      const app = harness(() => settings.promise);
      const controller = new AbortController();
      const ctx = extensionContextFixture({
        ...context(process.cwd()),
        signal: controller.signal,
      });

      const starting = app.emit("session_start", ctx);
      controller.abort();
      settings.resolve();
      yield* Effect.promise(() => starting);

      expect(app.registerTool).not.toHaveBeenCalled();
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
    }),
  );

  it.effect("invalidates pending settings preparation on shutdown", () =>
    Effect.gen(function* () {
      const settings = deferred<void>();
      const app = harness(() => settings.promise);
      const ctx = context(process.cwd());

      const starting = app.emit("session_start", ctx);
      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
      settings.resolve();
      yield* Effect.promise(() => starting);
      expect(app.registerTool).not.toHaveBeenCalled();
    }),
  );
});
