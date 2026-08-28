// Promise assertions characterize the Pi lifecycle boundary.
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeCapability,
} from "../src/code-mode/protocol.ts";
import {
  registerBackgroundTaskApplication,
  type BackgroundTaskApplicationBoundaries,
} from "../src/application.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

type Handler = ExtensionHandler<any, any>;

interface CapturedBackgroundTool {
  readonly name: string;
  readonly execute: (
    id: string,
    input: BackgroundTaskToolInput,
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
  const events = createEventBus();
  const tools: CapturedBackgroundTool[] = [];
  const activeTools: string[] = [];
  const registerTool = vi.fn((tool: CapturedBackgroundTool) => {
    tools.push(tool);
    if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
  });
  const fixture = {
    events,
    registerCommand: vi.fn(),
    registerTool,
    getActiveTools: () => [...activeTools],
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  };
  // SAFETY: Each test invokes only the ExtensionAPI members explicitly implemented above.
  registerBackgroundTaskApplication(fixture as typeof fixture & ExtensionAPI, {
    loadSettings,
  });
  return {
    tools,
    registerTool,
    events,
    activeTools,
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

  it.effect("publishes one current-session Code Mode capability and revokes it on shutdown", () =>
    Effect.gen(function* () {
      const app = harness(() => Promise.resolve());
      const ctx = extensionContextFixture({
        ...context(process.cwd()),
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionFile: () => undefined,
        },
      });
      yield* Effect.promise(() => app.emit("session_start", ctx));

      expect(() =>
        app.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
          version: BACKGROUND_TASK_CODE_MODE_VERSION,
          sessionId: "session-1",
          respond: () => Promise.reject(new Error("contained response rejection")),
        }),
      ).not.toThrow();

      const wrongSession: BackgroundTaskCodeModeCapability[] = [];
      app.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "other-session",
        respond: <Candidate>(candidate: Candidate) => {
          const capability = normalizeBackgroundTaskCodeModeCapability(candidate);
          if (capability) wrongSession.push(capability);
        },
      });
      expect(wrongSession).toEqual([]);

      const discovered: BackgroundTaskCodeModeCapability[] = [];
      app.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        sessionId: "session-1",
        respond: <Candidate>(candidate: Candidate) => {
          const capability = normalizeBackgroundTaskCodeModeCapability(candidate);
          if (capability) discovered.push(capability);
        },
      });
      expect(discovered).toHaveLength(1);
      const capability = discovered[0];
      if (!capability) throw new Error("background capability was not discovered");
      yield* Effect.promise(() =>
        expect(
          capability.execute(
            "nested-list-refused",
            { action: "list" },
            new AbortController().signal,
            0,
          ),
        ).rejects.toMatchObject({ _tag: "InvalidBackgroundCommandError" }),
      );
      const result = yield* Effect.promise(() =>
        capability.execute(
          "nested-list",
          { action: "list", state: "all" },
          new AbortController().signal,
          4_096,
        ),
      );
      expect(result).toEqual({ action: "list", text: "No background tasks.", tasks: [] });

      const started = yield* Effect.promise(() =>
        capability.execute(
          "nested-start",
          {
            action: "start",
            command: `node -e "setTimeout(() => {}, 10000)"`,
          },
          new AbortController().signal,
          4_096,
        ),
      );
      if (started.action !== "start") throw new Error("nested start returned the wrong action");
      const taskId = started.snapshot.id;
      const topLevelTool = app.tools[0];
      if (!topLevelTool) throw new Error("top-level background tool was not registered");
      const status = yield* Effect.promise(() =>
        topLevelTool.execute(
          "top-level-status",
          { action: "status", id: taskId },
          new AbortController().signal,
          undefined,
          ctx,
        ),
      );
      expect(status).toMatchObject({ details: { snapshot: { id: taskId } } });

      app.activeTools.splice(0, app.activeTools.length);
      yield* Effect.promise(() =>
        expect(
          capability.execute(
            "deactivated-list",
            { action: "list" },
            new AbortController().signal,
            4_096,
          ),
        ).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
      );

      yield* Effect.promise(() => app.emit("session_shutdown", ctx));
      yield* Effect.promise(() =>
        expect(
          capability.execute("stale-list", { action: "list" }, new AbortController().signal, 1_024),
        ).rejects.toMatchObject({ _tag: "PiSessionRuntimeError" }),
      );
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
