import { asyncRequest, defaultQuestion } from "./support/questionnaire.ts";
import { eventually, makeTuiHost, waitMounted } from "./support/host.ts";
import { startExtension, withoutRelayMarker } from "./support/extension.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { deferredPromise, extensionContextFixture, opaqueFixture } from "pi-cosmic-core/testing";
import { afterEach, expect, vi } from "vitest";
import * as externalEditor from "../src/boundary/host-external-editor.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

withoutRelayMarker();
afterEach(() => {
  vi.restoreAllMocks();
});

const harness = (
  loadPreviewSettings: Parameters<typeof startExtension>[0],
  overrides: Partial<ExtensionContext> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-application-" });
    const extension = yield* startExtension(loadPreviewSettings);
    const ctx = extensionContextFixture({
      cwd,
      hasUI: true,
      mode: "rpc",
      ui: { notify: vi.fn() },
      isProjectTrusted: () => true,
      ...overrides,
    });
    return { ...extension, ctx, emit: (name: string) => extension.emit(name, ctx) };
  });

type Harness = Effect.Success<ReturnType<typeof harness>>;

// Loads previews immediately and supplies the owned TUI host used by async dialogs.
const tuiHarness = (overrides: Partial<ExtensionContext> = {}) =>
  Effect.gen(function* () {
    const ui = makeTuiHost();
    const h = yield* harness(() => Promise.resolve(), {
      mode: "tui",
      ui: opaqueFixture(ui.ui),
      ...overrides,
    });
    return { h, ui };
  });

// Opens ask_user_async, acknowledges the mount, and returns the acquisition receipt.
const openMounted = (
  h: Harness,
  ui: ReturnType<typeof makeTuiHost>,
  id: string,
  signal?: AbortSignal,
) =>
  Effect.gen(function* () {
    const opening = h.tools
      .get("ask_user_async")!
      .execute(id, asyncRequest, signal, undefined, h.ctx);
    yield* waitMounted(ui);
    ui.mount!();
    return yield* Effect.promise(() => opening);
  });

const request = {
  questions: [{ ...defaultQuestion, choices: [defaultQuestion.choices[0]!] }],
} satisfies AskUserRequest;

layer(nodeFilePlatformLayer)("ask-user session admission", (it) => {
  it.effect("defers tool registration until preview settings resolve", () =>
    Effect.gen(function* () {
      const preview = deferredPromise();
      let loadSignal: AbortSignal | undefined;
      const h = yield* harness((_cwd, _projectTrusted, signal) => {
        loadSignal = signal;
        return preview.promise;
      });

      const starting = h.emit("session_start");
      yield* eventually(() => expect(loadSignal).toBeInstanceOf(AbortSignal));
      expect(loadSignal?.aborted).toBe(false);
      expect(h.registrations).toHaveLength(0);

      preview.resolve();
      yield* Effect.promise(() => starting);
      expect(h.registrations).toHaveLength(1);
      expect(h.tools.has("ask_user")).toBe(true);
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );

  it.effect("rejects a stale tool call while replacement startup is pending", () =>
    Effect.gen(function* () {
      const replacement = deferredPromise();
      let loads = 0;
      const h = yield* harness(() => {
        loads += 1;
        return loads === 1 ? Promise.resolve() : replacement.promise;
      });
      yield* Effect.promise(() => h.emit("session_start"));

      const tool = h.tools.get("ask_user");
      if (!tool) throw new Error("ask_user was not activated for the first session.");

      const replacing = h.emit("session_start");
      yield* eventually(() => expect(loads).toBe(2));
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
      expect(h.registrations).toHaveLength(1);
      const command = h.commands.get("ask-user");
      if (!command) throw new Error("The ask-user command was not registered.");
      const notify = vi.fn(() => {
        throw new Error("stale UI");
      });
      yield* Effect.promise(() => command.handler("", extensionContextFixture({ ui: { notify } })));
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
        const turn = new AbortController();
        const { h, ui } = yield* tuiHarness({ signal: turn.signal });
        yield* Effect.promise(() => h.emit("session_start"));
        expect(h.tools.has("ask_user_async")).toBe(true);
        const control = h.tools.get("ask_user_async_control")!;
        const signal = new AbortController();
        const receipt = yield* openMounted(h, ui, "call", signal.signal);
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
        const branch: Array<
          | { type: "custom_message"; customType: string; details: object }
          | { type: "custom"; customType: string; data: object }
        > = [];
        const sessionManager: ExtensionContext["sessionManager"] = opaqueFixture({
          getBranch: () => branch,
        });
        const { h, ui } = yield* tuiHarness({ sessionManager });
        yield* Effect.promise(() => h.emit("session_start"));
        yield* openMounted(h, ui, "open");
        ui.component!.handleInput?.("1");
        ui.component!.handleInput?.("\r");
        yield* eventually(() => expect(h.pi.sendMessage).toHaveBeenCalledOnce());
        const sent = h.pi.sendMessage.mock.calls[0]![0];
        const [customType, data] = h.pi.appendEntry.mock.calls[0]!;
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
            h.handlers.get("context")![0]!({ messages: [recorded, late, foreign] }, h.ctx),
          ),
        );
        expect(result).toEqual({ messages: [recorded, foreign] });
        // Pi can persist a revoked queued message after navigation. It is not a receipt.
        branch.push({ type: "custom_message", customType: late.customType, details: late.details });
        for (const activation of ["session_tree", "session_start", "session_tree"]) {
          yield* Effect.promise(() => h.emit(activation));
          const again = yield* Effect.promise(() =>
            Promise.resolve(
              h.handlers.get("context")![0]!({ messages: [recorded, late, foreign] }, h.ctx),
            ),
          );
          expect(again).toEqual({ messages: [recorded, foreign] });
        }
        yield* Effect.promise(() => h.emit("session_shutdown"));
      }),
  );

  it.effect("async admission respects unrelated coalesced UI prompts", () =>
    Effect.gen(function* () {
      const { h, ui } = yield* tuiHarness();
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
      yield* openMounted(h, ui, "open");
      yield* Effect.promise(() => h.emit("session_shutdown"));
    }),
  );

  for (const lateResult of ["success", "rejection"] as const) {
    it.effect(`replacement joins editor termination and TUI restoration (${lateResult})`, () =>
      Effect.gen(function* () {
        const terminated = deferredPromise();
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
        const { h, ui } = yield* tuiHarness();
        yield* Effect.promise(() => h.emit("session_start"));
        const start = h.tools.get("ask_user_async")!;
        yield* openMounted(h, ui, "open");
        const oldComponent = ui.component!;
        oldComponent.handleInput?.("n");
        oldComponent.handleInput?.("external");
        expect(editorSignal?.aborted).toBe(false);
        expect(ui.tui.stop).toHaveBeenCalledOnce();
        let replaced = false;
        const replacing = h.emit("session_start").then(() => {
          replaced = true;
        });
        yield* eventually(() => expect(editorSignal?.aborted).toBe(true));
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
        yield* eventually(() => expect(ui.customCalls).toBe(2));
        ui.mount!();
        yield* Effect.promise(() => next);
        yield* Effect.promise(() => h.emit("session_shutdown"));
        yield* Effect.promise(() => h.emit("session_shutdown"));
        expect(ui.tui.start).toHaveBeenCalledOnce();
        expect(ui.done).toHaveBeenCalledTimes(2);
      }),
    );
  }
});
