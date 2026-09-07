import { defaultQuestion } from "./support/questionnaire.ts";
import { controlled, makeTuiHost as asyncUi } from "./support/host.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import * as externalEditor from "../src/boundary/host-external-editor.ts";
import { askUserWithDependencies } from "../src/application.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type {
  AskUserRequest,
  AskUserAsyncRequest,
  AskUserAsyncControl,
} from "../src/questionnaire/schema.ts";
import type {
  AsyncQuestionnaireSnapshot,
  AsyncQuestionnaireResult,
} from "../src/questionnaire/async-model.ts";

type Handler = ExtensionHandler<any, any>;
interface CapturedTool {
  readonly name: string;
  readonly execute: (
    id: string,
    input: AskUserRequest | AskUserAsyncRequest | AskUserAsyncControl,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: AskUserOutcome | AsyncQuestionnaireSnapshot | AsyncQuestionnaireResult;
  }>;
}
interface CapturedCommand {
  readonly handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

beforeEach(() => {
  vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
  vi.stubEnv("PI_SUBAGENT_RUN_ID", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const harness = (
  loadPreviewSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
  ) => Promise<void>,
  overrides: Partial<ExtensionContext> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-application-" });
    const agentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-agent-" });
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory));
    const handlers = new Map<string, Handler>();
    let command: CapturedCommand | undefined;
    let tool: CapturedTool | undefined;
    const tools = new Map<string, CapturedTool>();
    const fixture = {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerCommand: vi.fn((name: string, definition: CapturedCommand) => {
        if (name === "ask-user") command = definition;
      }),
      sendMessage: vi.fn(),
      registerMessageRenderer: vi.fn(),
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: CapturedTool) => {
        tool = definition;
        tools.set(definition.name, definition);
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
      ...overrides,
    };
    // SAFETY: The startup path reads only the context fields supplied by this fixture.
    const ctx = contextFixture as typeof contextFixture & ExtensionContext;
    const emit = (name: string) => Promise.resolve(handlers.get(name)?.({}, ctx));
    return {
      ctx,
      emit,
      fixture,
      tools,
      handlers,
      get command() {
        return command;
      },
      get tool() {
        return tool;
      },
    };
  });

const request: AskUserRequest = {
  questions: [{ ...defaultQuestion, choices: [defaultQuestion.choices[0]!] }],
};

const asyncRequest: AskUserAsyncRequest = {
  ...request,
  independentWork: "Inspect fixtures",
  blockedWork: "Implement choice",
  questions: request.questions.map((question) => ({
    ...question,
    choices: [...question.choices, { value: "b", label: "B", description: "Choose B." }],
  })),
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
      yield* Effect.promise(() => command.handler("", { ui: { notify } } as never));
      expect(notify).toHaveBeenCalledOnce();
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );

  it.effect(
    "marked TUI children expose only blocking relay, never a child-local async dialog",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("PI_SUBAGENT_CHILD", "1");
        vi.stubEnv("PI_SUBAGENT_RUN_ID", "child-run");
        const h = yield* harness(() => Promise.resolve(), { mode: "tui" });
        yield* Effect.promise(() => h.emit("session_start"));
        expect(h.tools.has("ask_user")).toBe(true);
        expect(h.tools.has("ask_user_async")).toBe(false);
        expect(h.tools.has("ask_user_async_control")).toBe(false);
        yield* Effect.promise(() =>
          expect(
            h.tools.get("ask_user")!.execute("call", request, undefined, undefined, h.ctx),
          ).rejects.toMatchObject({ operation: "relay" }),
        );
        yield* Effect.promise(() => h.emit("session_shutdown"));
      }),
  );

  it.effect(
    "TUI async acquisition returns before answer, survives tool abort, and tree replacement revokes it",
    () =>
      Effect.gen(function* () {
        const ui = asyncUi();
        const turn = new AbortController();
        // SAFETY: This UI fake supplies the custom/notification/status members used by the TUI flow.
        const h = yield* harness(() => Promise.resolve(), {
          mode: "tui",
          ui: ui.ui as never,
          signal: turn.signal,
        });
        yield* Effect.promise(() => h.emit("session_start"));
        expect(h.tools.has("ask_user_async")).toBe(true);
        const start = h.tools.get("ask_user_async")!;
        const control = h.tools.get("ask_user_async_control")!;
        const signal = new AbortController();
        const opening = start.execute("call", asyncRequest, signal.signal, undefined, h.ctx);
        yield* Effect.promise(() => vi.waitFor(() => expect(ui.mount).toBeDefined()));
        ui.mount!();
        const receipt = yield* Effect.promise(() => opening);
        expect(receipt.details).toMatchObject({ status: "pending" });
        if (!("requestId" in receipt.details)) throw new Error("Missing async receipt");
        const requestId = receipt.details.requestId;
        signal.abort();
        turn.abort();
        expect(ui.done).not.toHaveBeenCalled();
        const status = yield* Effect.promise(() =>
          control.execute("status", { action: "status", requestId }, undefined, undefined, h.ctx),
        );
        expect(status.details).toMatchObject({ requests: [{ status: "pending" }] });
        yield* Effect.promise(() => h.emit("session_tree"));
        expect(ui.done).toHaveBeenCalledOnce();
        yield* Effect.promise(() =>
          expect(
            control.execute("stale", { action: "status" }, undefined, undefined, h.ctx),
          ).rejects.toMatchObject({ _tag: "AskUserRuntimeClosedError" }),
        );
        const fresh = h.tools.get("ask_user_async_control")!;
        const result = yield* Effect.promise(() =>
          fresh.execute("fresh", { action: "status" }, undefined, undefined, h.ctx),
        );
        expect(result.details).toEqual({ requests: [] });
        yield* Effect.promise(() => h.emit("session_shutdown"));
        yield* Effect.promise(() => h.emit("session_shutdown"));
        expect(ui.done).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    "tree replacement preserves already-recorded answers but filters late old steering",
    () =>
      Effect.gen(function* () {
        const ui = asyncUi();
        const branch: Array<
          | { type: "custom_message"; customType: string; details: object }
          | { type: "custom"; customType: string; data: object }
        > = [];
        // SAFETY: Startup and history filtering read only getBranch on this session manager fixture.
        const sessionManager: ExtensionContext["sessionManager"] = {
          getBranch: () => branch,
        } as never;
        // SAFETY: The fake supplies only the UI methods used by this questionnaire flow.
        const h = yield* harness(() => Promise.resolve(), {
          mode: "tui",
          ui: ui.ui as never,
          sessionManager,
        });
        yield* Effect.promise(() => h.emit("session_start"));
        const opening = h.tools
          .get("ask_user_async")!
          .execute("open", asyncRequest, undefined, undefined, h.ctx);
        yield* Effect.promise(() => vi.waitFor(() => expect(ui.mount).toBeDefined()));
        ui.mount!();
        yield* Effect.promise(() => opening);
        ui.component!.handleInput?.("1");
        ui.component!.handleInput?.("\r");
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(h.fixture.sendMessage).toHaveBeenCalledOnce()),
        );
        const sent = h.fixture.sendMessage.mock.calls[0]![0];
        const [customType, data] = h.fixture.appendEntry.mock.calls[0]!;
        branch.push({ type: "custom", customType, data });
        branch.push({ type: "custom_message", customType: sent.customType, details: sent.details });
        yield* Effect.promise(() => h.emit("session_tree"));
        const recorded = { role: "custom", ...sent };
        const late = {
          role: "custom",
          ...sent,
          details: { ...sent.details, deliveryId: "late-old-answer" },
        };
        const foreign = { role: "custom", customType: "another-extension", content: "keep" };
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            h.handlers.get("context")!({ messages: [recorded, late, foreign] }, h.ctx),
          ),
        );
        expect(result).toEqual({ messages: [recorded, foreign] });
        // Pi can persist a revoked queued message after navigation. It is not a receipt.
        branch.push({ type: "custom_message", customType: late.customType, details: late.details });
        for (const activation of ["session_tree", "session_start", "session_tree"]) {
          yield* Effect.promise(() => h.emit(activation));
          const again = yield* Effect.promise(() =>
            Promise.resolve(
              h.handlers.get("context")!({ messages: [recorded, late, foreign] }, h.ctx),
            ),
          );
          expect(again).toEqual({ messages: [recorded, foreign] });
        }
        yield* Effect.promise(() => h.emit("session_shutdown"));
      }),
  );

  it.effect("async admission respects unrelated coalesced UI prompts", () =>
    Effect.gen(function* () {
      const ui = asyncUi();
      // SAFETY: The fixture supplies the UI members used by this flow.
      const h = yield* harness(() => Promise.resolve(), { mode: "tui", ui: ui.ui as never });
      yield* Effect.promise(() => h.emit("session_start"));
      yield* Effect.promise(() => h.emit("ui_prompt_start"));
      const start = h.tools.get("ask_user_async")!;
      yield* Effect.promise(() =>
        expect(
          start.execute("busy", asyncRequest, undefined, undefined, h.ctx),
        ).rejects.toMatchObject({ reason: "busy" }),
      );
      expect(ui.mount).toBeUndefined();
      yield* Effect.promise(() => h.emit("ui_prompt_end"));
      const pending = start.execute("open", asyncRequest, undefined, undefined, h.ctx);
      yield* Effect.promise(() => vi.waitFor(() => expect(ui.mount).toBeDefined()));
      ui.mount!();
      yield* Effect.promise(() => pending);
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );

  for (const lateResult of ["success", "rejection"] as const) {
    it.effect(`replacement joins editor termination and TUI restoration (${lateResult})`, () =>
      Effect.gen(function* () {
        const ui = asyncUi();
        const terminated = controlled();
        let editorSignal: AbortSignal | undefined;
        const edit = vi
          .spyOn(externalEditor, "editWithExternalEditor")
          .mockImplementation((tui, _command, _value, signal) => {
            editorSignal = signal;
            tui.stop();
            return terminated.promise.then(() => {
              tui.start();
              tui.requestRender(true);
              if (lateResult === "rejection") throw new Error("late editor failure");
              return "late edited text";
            });
          });
        // SAFETY: This fixture implements the UI methods consumed by the host.
        const h = yield* harness(() => Promise.resolve(), { mode: "tui", ui: ui.ui as never });
        yield* Effect.promise(() => h.emit("session_start"));
        const start = h.tools.get("ask_user_async")!;
        const opening = start.execute("open", asyncRequest, undefined, undefined, h.ctx);
        yield* Effect.promise(() => vi.waitFor(() => expect(ui.mount).toBeDefined()));
        ui.mount!();
        yield* Effect.promise(() => opening);
        const oldComponent = ui.component!;
        oldComponent.handleInput?.("n");
        oldComponent.handleInput?.("external");
        expect(editorSignal?.aborted).toBe(false);
        expect(ui.tui.stop).toHaveBeenCalledOnce();
        let replaced = false;
        const replacing = h.emit("session_start").then(() => {
          replaced = true;
        });
        yield* Effect.promise(() => vi.waitFor(() => expect(editorSignal?.aborted).toBe(true)));
        for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
        expect(replaced).toBe(false);
        expect(ui.tui.start).not.toHaveBeenCalled();
        yield* Effect.promise(() =>
          expect(
            start.execute("stale", asyncRequest, undefined, undefined, h.ctx),
          ).rejects.toBeDefined(),
        );
        expect(ui.customCalls).toBe(1);
        terminated.resolve();
        yield* Effect.promise(() => replacing);
        expect(ui.tui.start).toHaveBeenCalledOnce();
        // A detached old component cannot admit another editor even after late settlement.
        yield* Effect.promise(() => Promise.resolve());
        oldComponent.handleInput?.("external");
        expect(edit).toHaveBeenCalledOnce();
        const next = h.tools
          .get("ask_user_async")!
          .execute("next", asyncRequest, undefined, undefined, h.ctx);
        yield* Effect.promise(() => vi.waitFor(() => expect(ui.customCalls).toBe(2)));
        ui.mount!();
        yield* Effect.promise(() => next);
        yield* Effect.promise(() => h.emit("session_shutdown"));
        yield* Effect.promise(() => h.emit("session_shutdown"));
        expect(ui.tui.start).toHaveBeenCalledOnce();
        expect(ui.done).toHaveBeenCalledTimes(2);
      }),
    );
  }

  it.effect("RPC retains only the compatible blocking tool", () =>
    Effect.gen(function* () {
      const h = yield* harness(() => Promise.resolve());
      yield* Effect.promise(() => h.emit("session_start"));
      expect([...h.tools.keys()]).toEqual(["ask_user"]);
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );
});
