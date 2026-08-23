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
import { registerBackgroundTerminalsApplication } from "../src/application.ts";

type Handler = ExtensionHandler<any, any>;

interface CapturedBackgroundTool {
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

const extensionApiFixture = <Fixture extends object>(fixture: Fixture): Fixture & ExtensionAPI => {
  // SAFETY: Each test invokes only the ExtensionAPI members explicitly implemented by its fixture.
  return fixture as Fixture & ExtensionAPI;
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

describe("background-terminal Pi lifecycle", () => {
  it.effect("makes out-of-order settings preparation latest-generation wins", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const first = deferred<void>();
      const second = deferred<void>();
      const loads: Array<readonly [string, boolean]> = [];
      const tools: string[] = [];
      const pi = extensionApiFixture({
        events: undefined,
        registerCommand: vi.fn(),
        registerTool: vi.fn((tool: { readonly name: string }) => tools.push(tool.name)),
        on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
      });
      registerBackgroundTerminalsApplication(pi, {
        loadSettings: (cwd, trusted) => {
          loads.push([cwd, trusted]);
          return loads.length === 1 ? first.promise : second.promise;
        },
      });

      const firstContext = context(`${process.cwd()}/first`);
      const secondContext = context(`${process.cwd()}/second`);
      const firstStart = Promise.resolve(handlers.get("session_start")?.({}, firstContext));
      const secondStart = Promise.resolve(handlers.get("session_start")?.({}, secondContext));

      second.resolve();
      yield* Effect.promise(() => secondStart);
      expect(tools).toEqual(["background_terminal"]);

      first.resolve();
      yield* Effect.promise(() => firstStart);
      expect(tools).toEqual(["background_terminal"]);
      expect(loads).toEqual([
        [`${process.cwd()}/first`, false],
        [`${process.cwd()}/second`, false],
      ]);
      yield* Effect.promise(() =>
        Promise.resolve(handlers.get("session_shutdown")?.({}, secondContext)),
      );
    }),
  );

  it.effect(
    "deactivates the prior runtime immediately while replacement settings are pending",
    () =>
      Effect.gen(function* () {
        const handlers = new Map<string, Handler>();
        const replacement = deferred<void>();
        const registered: CapturedBackgroundTool[] = [];
        let loadCount = 0;
        const pi = extensionApiFixture({
          events: undefined,
          registerCommand: vi.fn(),
          registerTool: vi.fn((tool: CapturedBackgroundTool) => registered.push(tool)),
          on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
        });
        registerBackgroundTerminalsApplication(pi, {
          loadSettings: () => (++loadCount === 1 ? Promise.resolve() : replacement.promise),
        });
        const ctx = context(process.cwd());
        yield* Effect.promise(() => Promise.resolve(handlers.get("session_start")?.({}, ctx)));
        expect(registered).toHaveLength(1);

        const replacing = Promise.resolve(handlers.get("session_start")?.({}, ctx));
        const tool = registered[0];
        if (!tool) throw new Error("background tool registration was not captured");
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
        yield* Effect.promise(() => Promise.resolve(handlers.get("session_shutdown")?.({}, ctx)));
      }),
  );

  it.effect("invalidates pending settings preparation when the captured session aborts", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const settings = deferred<void>();
      const registerTool = vi.fn();
      const pi = extensionApiFixture({
        events: undefined,
        registerCommand: vi.fn(),
        registerTool,
        on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
      });
      registerBackgroundTerminalsApplication(pi, { loadSettings: () => settings.promise });
      const controller = new AbortController();
      const ctx = extensionContextFixture({
        ...context(process.cwd()),
        signal: controller.signal,
      });

      const starting = Promise.resolve(handlers.get("session_start")?.({}, ctx));
      controller.abort();
      settings.resolve();
      yield* Effect.promise(() => starting);

      expect(registerTool).not.toHaveBeenCalled();
      yield* Effect.promise(() => Promise.resolve(handlers.get("session_shutdown")?.({}, ctx)));
    }),
  );

  it.effect("invalidates pending settings preparation on shutdown", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const settings = deferred<void>();
      const registerTool = vi.fn();
      const pi = extensionApiFixture({
        events: undefined,
        registerCommand: vi.fn(),
        registerTool,
        on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
      });
      registerBackgroundTerminalsApplication(pi, { loadSettings: () => settings.promise });
      const ctx = context(process.cwd());

      const starting = Promise.resolve(handlers.get("session_start")?.({}, ctx));
      yield* Effect.promise(() => Promise.resolve(handlers.get("session_shutdown")?.({}, ctx)));
      settings.resolve();
      yield* Effect.promise(() => starting);
      expect(registerTool).not.toHaveBeenCalled();
    }),
  );
});
