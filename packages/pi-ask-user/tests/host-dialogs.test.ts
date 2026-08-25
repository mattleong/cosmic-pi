import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vitest";
import { HostDialogs } from "../src/boundary/host-dialogs.ts";
import { makeAskUserDialogBridge, type AskUserDialogBridge } from "../src/boundary/host-ui.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

const request: AskUserRequest = {
  questions: [
    {
      key: "library",
      title: "Library",
      prompt: "Which library?",
      mode: "single",
      choices: [
        { value: "a", label: "A", description: "Choose A." },
        { value: "b", label: "B", description: "Choose B." },
      ],
    },
  ],
};

const opaqueHostFixture = <Value>(value: Value): never => {
  // SAFETY: Tests supply every opaque host member exercised by HostDialogs.
  return value as never;
};

const run = (
  ctx: ExtensionContext,
  selectedRequest: AskUserRequest = request,
  options?: { readonly bridge?: AskUserDialogBridge; readonly signal?: AbortSignal },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          HostDialogs.layer(ctx, options?.bridge ?? makeAskUserDialogBridge()),
        );
        return yield* Effect.provide(
          Effect.flatMap(HostDialogs, (host) => host.ask(selectedRequest)),
          context,
        );
      }),
    ),
    options?.signal ? { signal: options.signal } : undefined,
  );

describe("RPC questionnaire boundary", () => {
  it("uses native select and returns stable values", () => {
    const select = vi.fn((_title: string, options: string[], _opts?: { signal?: AbortSignal }) =>
      Promise.resolve(options[1]),
    );
    const ui = { select, input: vi.fn(), notify: vi.fn() };
    const ctx = opaqueHostFixture({ mode: "rpc", hasUI: true, ui });

    return run(ctx).then((outcome) => {
      expect(outcome).toEqual({
        outcome: "submitted",
        answers: [{ key: "library", kind: "choices", values: ["b"], labels: ["B"] }],
      });
      expect(select.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  it("treats a dismissed RPC dialog as cancellation without returning drafts", () => {
    const ui = {
      select: vi.fn(() => Promise.resolve(undefined)),
      input: vi.fn(),
      notify: vi.fn(),
    };
    return expect(run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui }))).resolves.toEqual({
      outcome: "cancelled",
      answers: [],
    });
  });

  it("returns to single-select choices when the custom-answer input is dismissed", () => {
    let calls = 0;
    const select = vi.fn((_title: string, options: string[]) =>
      Promise.resolve(calls++ === 0 ? options[options.length - 1] : options[0]),
    );
    const notify = vi.fn(() => {
      throw new Error("stale notification host");
    });
    const ui = { select, input: vi.fn(() => Promise.resolve(undefined)), notify };
    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui })).then((outcome) => {
      expect(outcome).toMatchObject({
        outcome: "submitted",
        answers: [{ key: "library", values: ["a"] }],
      });
      expect(select).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledOnce();
    });
  });

  it("re-prompts all-numeric multi-select values that are out of range", () => {
    const multiple: AskUserRequest = {
      questions: [{ ...request.questions[0]!, mode: "multiple" }],
    };
    const input = vi.fn().mockResolvedValueOnce("5").mockResolvedValueOnce("1,2");
    const notify = vi.fn();
    const ui = { select: vi.fn(), input, notify };
    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui }), multiple).then((outcome) => {
      expect(outcome).toMatchObject({
        outcome: "submitted",
        answers: [{ key: "library", values: ["a", "b"] }],
      });
      expect(input).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledOnce();
    });
  });
});

describe("TUI questionnaire boundary", () => {
  effectIt.effect("stops an interrupted lazy open before settings or UI mutation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => import("../src/ui/dialog.ts"));
      const bridge = makeAskUserDialogBridge();
      const resume = vi.fn();
      bridge.activate(resume);
      const custom = vi.fn(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
      const ctx = opaqueHostFixture({
        mode: "tui",
        hasUI: true,
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        ui: { custom },
      });
      const controller = new AbortController();

      const opening = run(ctx, request, { bridge, signal: controller.signal });
      controller.abort();
      yield* Effect.promise(() => expect(opening).rejects.toBeDefined());

      expect(custom).not.toHaveBeenCalled();
      expect(bridge.resume()).toBe(true);
      expect(resume).toHaveBeenCalledOnce();
    }),
  );

  effectIt.effect("contains a hostile done callback and clears its current bridge token", () =>
    Effect.gen(function* () {
      const bridge = makeAskUserDialogBridge();
      const done = vi.fn((_outcome: AskUserOutcome) => {
        throw new Error("hostile done");
      });
      type DialogFactory = (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (outcome: AskUserOutcome) => void,
      ) => Component;
      const custom = vi.fn((factory: DialogFactory) => {
        const tui: TUI = opaqueHostFixture({ requestRender: vi.fn() });
        const theme: Theme = opaqueHostFixture({
          bold: (value: string) => value,
          fg: (_color: string, value: string) => value,
          bg: (_color: string, value: string) => value,
        });
        const keybindings: KeybindingsManager = opaqueHostFixture({ matches: () => false });
        const component = factory(tui, theme, keybindings, done);
        expect(() => component.handleInput?.("\x1b")).not.toThrow();
        return Promise.resolve({ outcome: "cancelled" as const, answers: [] as const });
      });
      const ctx = opaqueHostFixture({
        mode: "tui",
        hasUI: true,
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        ui: { custom },
      });

      const outcome = yield* Effect.promise(() => run(ctx, request, { bridge }));

      expect(outcome).toEqual({ outcome: "cancelled", answers: [] });
      expect(done).toHaveBeenCalledOnce();
      expect(bridge.resume()).toBe(false);
    }),
  );

  effectIt.effect("does not clear another bridge owner when custom rejects before activation", () =>
    Effect.gen(function* () {
      const bridge = makeAskUserDialogBridge();
      const resume = vi.fn();
      bridge.activate(resume);
      const custom = vi.fn(() => Promise.reject(new Error("custom unavailable")));
      const ctx = opaqueHostFixture({
        mode: "tui",
        hasUI: true,
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        ui: { custom },
      });

      yield* Effect.promise(() =>
        expect(run(ctx, request, { bridge })).rejects.toMatchObject({
          _tag: "AskUserHostError",
          operation: "render",
        }),
      );
      expect(custom).toHaveBeenCalledOnce();
      expect(bridge.resume()).toBe(true);
      expect(resume).toHaveBeenCalledOnce();
    }),
  );
});
