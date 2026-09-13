import { expect, vi } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeTuiHost, opaqueHostFixture } from "./support/host.ts";
import { makeOwnedFormTuiHost } from "../src/boundary/host-form-tui.ts";
import { makeAskUserTuiHost } from "../src/boundary/host-tui.ts";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";
import { makeAskUserPromptGate } from "../src/boundary/host-prompt.ts";
import { askUserWithDependencies } from "../src/application.ts";
import { queryOwnedFormCapability, type QuestionnaireEvents } from "../src/protocol.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const request = { kind: "form", message: "private", fields: [] } as const;
const owner = { extensionId: "pi-mcp", operationId: "o", requestId: "r", label: "MCP" };
const foreign = { render: () => ["foreign"], invalidate: () => {} };

it.effect(
  "uses live viewport options and allocations in both owned dialog hosts without remounting",
  () =>
    Effect.gen(function* () {
      for (const kind of ["form", "questionnaire"]) {
        const h = makeTuiHost();
        const bridge = makeAskUserDialogBridge();
        const controller = new AbortController();
        const presentation =
          kind === "form"
            ? makeOwnedFormTuiHost(h.ctx, bridge)(
                { ...request, message: "prose\n".repeat(200) },
                owner,
              ).pipe(Effect.asVoid)
            : makeAskUserTuiHost(
                h.ctx,
                bridge,
              )({
                questions: [
                  {
                    key: "q",
                    title: "Question",
                    prompt: "prose\n".repeat(200),
                    mode: "single",
                    choices: [
                      { value: "a", label: "A", description: "A" },
                      { value: "b", label: "B", description: "B" },
                    ],
                  },
                ],
              }).pipe(Effect.asVoid);
        const pending = Effect.runPromise(presentation, { signal: controller.signal });
        const rejected = expect(pending).rejects.toBeDefined();
        yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
        h.mount!();
        const component = h.component!;
        const options = h.ui.custom.mock.calls[0]![1].overlayOptions;
        expect(options.width).toBe(180);
        expect(component.render(180).length).toBeLessThanOrEqual(54);
        component.handleInput?.("b");
        h.tui.terminal.columns = 160;
        h.tui.terminal.rows = 24;
        expect(bridge.resume()).toBe(true);
        expect(h.component).toBe(component);
        expect(h.ui.custom.mock.calls[0]![1].overlayOptions).toBe(options);
        expect(options.width).toBe(160);
        expect(options.maxHeight).toBe(24);
        expect(options.anchor).toBe("bottom-center");
        expect(component.render(160).length).toBeLessThanOrEqual(24);
        controller.abort();
        yield* Effect.promise(() => rejected);
        expect(h.stack).toEqual([]);
      }
    }),
);

it.effect("hides and resumes the same draft while cancellation preserves foreign overlays", () =>
  Effect.gen(function* () {
    const h = makeTuiHost();
    const bridge = makeAskUserDialogBridge();
    const controller = new AbortController();
    const pending = Effect.runPromise(makeOwnedFormTuiHost(h.ctx, bridge)(request, owner), {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBeDefined();
    yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
    h.mount!();
    h.component!.handleInput?.("b");
    expect(bridge.resume()).toBe(true);
    h.component!.handleInput?.("b");
    h.showOverlay(foreign);
    controller.abort();
    yield* Effect.promise(() => rejected);
    expect(h.stack).toEqual([foreign]);
    expect(bridge.resume()).toBe(false);
  }),
);

it.effect("cleans a late mount without globally popping an unrelated overlay", () =>
  Effect.gen(function* () {
    const h = makeTuiHost();
    const bridge = makeAskUserDialogBridge();
    const controller = new AbortController();
    const pending = Effect.runPromise(makeOwnedFormTuiHost(h.ctx, bridge)(request, owner), {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBeDefined();
    yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
    h.showOverlay(foreign);
    controller.abort();
    yield* Effect.promise(() => rejected);
    h.mount!();
    expect(h.stack).toEqual([foreign]);
    expect(bridge.resume()).toBe(false);
  }),
);

it.effect(
  "waits for foreign prompt release before mounting and never waits for a broken custom Promise",
  () =>
    Effect.gen(function* () {
      const gate = makeAskUserPromptGate();
      gate.started();
      const h = makeTuiHost(gate);
      const controller = new AbortController();
      const pending = Effect.runPromise(
        makeOwnedFormTuiHost(h.ctx, makeAskUserDialogBridge(), gate)(request, owner),
        { signal: controller.signal },
      );
      const rejected = expect(pending).rejects.toBeDefined();
      yield* Effect.yieldNow;
      expect(h.customCalls).toBe(0);
      gate.ended();
      yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
      h.mount!();
      h.done.mockImplementation(() => {
        throw new Error("private host diagnostic");
      });
      controller.abort();
      yield* Effect.promise(() => rejected);
      expect(h.stack).toEqual([]);
    }),
);

it.effect("does not advertise owned forms without a real UI", () =>
  Effect.gen(function* () {
    const callbacks = new Map<string, (event: never, ctx: ExtensionContext) => Promise<void>>();
    const busCallbacks = new Map<string, Parameters<QuestionnaireEvents["on"]>[1]>();
    const events: QuestionnaireEvents = {
      on: (name, handler) => {
        busCallbacks.set(name, handler);
        return () => {
          busCallbacks.delete(name);
        };
      },
      emit: (name, data) => {
        busCallbacks.get(name)?.(data);
      },
    };
    const pi = opaqueHostFixture({
      events,
      on: (name: string, handler: (event: never, ctx: ExtensionContext) => Promise<void>) =>
        callbacks.set(name, handler),
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
    });
    askUserWithDependencies(pi, () => Promise.resolve());
    const ctx: ExtensionContext = opaqueHostFixture({
      hasUI: false,
      mode: "print",
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    });
    yield* Effect.promise(() => callbacks.get("session_start")!(opaqueHostFixture({}), ctx));
    expect(queryOwnedFormCapability(events, "session")).toBeUndefined();
  }),
);
