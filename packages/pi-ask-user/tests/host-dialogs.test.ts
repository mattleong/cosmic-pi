import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { makeAskUserHost } from "../src/boundary/host-dialogs.ts";
import { makeAskUserDialogBridge, type AskUserDialogBridge } from "../src/boundary/host-ui.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import { MAX_NOTE_LENGTH, type AskUserRequest } from "../src/questionnaire/schema.ts";

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
  // SAFETY: Tests supply every opaque host member exercised by the dialog boundary.
  return value as never;
};

type TestDialogFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (outcome: AskUserOutcome) => void,
) => Component;

interface TestDialogFactoryHost {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
}

const dialogFactoryHost = (): TestDialogFactoryHost => ({
  tui: opaqueHostFixture({ requestRender: vi.fn() }),
  theme: opaqueHostFixture({
    bold: (value: string) => value,
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
  }),
  keybindings: opaqueHostFixture({ matches: () => false }),
});

interface PromiseGate<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
}

const controllable = <Value>(): PromiseGate<Value> =>
  // SAFETY: Supported Node versions implement Promise.withResolvers; the configured libs omit it.
  (
    Promise as PromiseConstructor & {
      withResolvers<Resolved>(): PromiseGate<Resolved>;
    }
  ).withResolvers<Value>();

const nonsettling = <Value>(): Promise<Value> => controllable<Value>().promise;

const run = (
  ctx: ExtensionContext,
  selectedRequest: AskUserRequest = request,
  options?: { readonly bridge?: AskUserDialogBridge; readonly signal?: AbortSignal },
) =>
  Effect.runPromise(
    makeAskUserHost(ctx, options?.bridge ?? makeAskUserDialogBridge())(selectedRequest),
    options?.signal ? { signal: options.signal } : undefined,
  );

describe("RPC questionnaire boundary", () => {
  it("uses interruption-linked native dialogs and returns stable values after review", () => {
    const select = vi.fn((_title: string, options: string[], _opts?: { signal?: AbortSignal }) => {
      if (options.includes("Continue without a note")) return Promise.resolve(options[0]);
      if (options.includes("Submit answers")) return Promise.resolve(options[0]);
      return Promise.resolve(options[1]);
    });
    const ui = { select, input: vi.fn(), notify: vi.fn() };
    const ctx = opaqueHostFixture({ mode: "rpc", hasUI: true, ui });

    return run(ctx).then((outcome) => {
      expect(outcome).toEqual({
        outcome: "submitted",
        answers: [{ key: "library", kind: "choices", values: ["b"], labels: ["B"] }],
      });
      expect(select).toHaveBeenCalledTimes(3);
      expect(select.mock.calls.every((call) => call[2]?.signal instanceof AbortSignal)).toBe(true);
    });
  });

  effectIt.effect(
    "aborts the pending native dialog when RPC questionnaire execution is interrupted",
    () =>
      Effect.gen(function* () {
        let nativeSignal: AbortSignal | undefined;
        const select = vi.fn(
          (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
            nativeSignal = opts?.signal;
            return delay(10_000, undefined, { signal: nativeSignal });
          },
        );
        const ui = { select, input: vi.fn(), notify: vi.fn() };
        const controller = new AbortController();
        const pending = run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui }), request, {
          signal: controller.signal,
        });

        yield* Effect.promise(() =>
          vi.waitFor(() => expect(nativeSignal).toBeInstanceOf(AbortSignal)),
        );
        controller.abort();

        yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
        expect(nativeSignal?.aborted).toBe(true);
      }),
  );

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
    let questionCalls = 0;
    const select = vi.fn((_title: string, options: string[]) => {
      if (options.includes("Continue without a note")) return Promise.resolve(options[0]);
      if (options.includes("Submit answers")) return Promise.resolve(options[0]);
      return Promise.resolve(questionCalls++ === 0 ? options[options.length - 1] : options[0]);
    });
    const notify = vi.fn(() => {
      throw new Error("stale notification host");
    });
    const ui = { select, input: vi.fn(() => Promise.resolve(undefined)), notify };
    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui })).then((outcome) => {
      expect(outcome).toMatchObject({
        outcome: "submitted",
        answers: [{ key: "library", values: ["a"] }],
      });
      expect(questionCalls).toBe(2);
      expect(notify).toHaveBeenCalledOnce();
    });
  });

  it("accepts an optional bounded note without changing the selected answer", () => {
    const tooLong = "x".repeat(MAX_NOTE_LENGTH + 1);
    const note = "Why \u001b[31mB\u001b[0m matters.";
    const input = vi.fn().mockResolvedValueOnce(tooLong).mockResolvedValueOnce(note);
    let reviewTitle: string | undefined;
    const select = vi.fn((title: string, options: string[]) => {
      if (options.includes("Add a note")) return Promise.resolve(options[1]);
      if (options.includes("Submit answers")) {
        reviewTitle = title;
        return Promise.resolve(options[0]);
      }
      return Promise.resolve(options[1]);
    });
    const notify = vi.fn();
    const ui = { select, input, notify };

    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui })).then((outcome) => {
      expect(outcome).toEqual({
        outcome: "submitted",
        answers: [
          {
            key: "library",
            kind: "choices",
            values: ["b"],
            labels: ["B"],
            note,
          },
        ],
      });
      expect(reviewTitle).toContain("Why B matters.");
      expect(reviewTitle).not.toContain("\u001b");
      expect(input).toHaveBeenCalledTimes(2);
      expect(input.mock.calls.every((call) => call[2]?.signal instanceof AbortSignal)).toBe(true);
      expect(notify).toHaveBeenCalledOnce();
    });
  });

  it("reviews answers, edits a choice, and preserves its existing note", () => {
    const note = "Keep this context.";
    let questionCalls = 0;
    let reviewCalls = 0;
    const select = vi.fn((_title: string, options: string[]) => {
      if (options.includes("Add a note")) return Promise.resolve(options[1]);
      if (options.includes("Keep current note")) return Promise.resolve(options[0]);
      if (options.includes("Submit answers"))
        return Promise.resolve(reviewCalls++ === 0 ? options[1] : options[0]);
      return Promise.resolve(options[questionCalls++]);
    });
    const ui = { select, input: vi.fn(() => Promise.resolve(note)), notify: vi.fn() };

    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui })).then((outcome) => {
      expect(outcome).toEqual({
        outcome: "submitted",
        answers: [
          {
            key: "library",
            kind: "choices",
            values: ["b"],
            labels: ["B"],
            note,
          },
        ],
      });
      expect(questionCalls).toBe(2);
      expect(reviewCalls).toBe(2);
    });
  });

  it("can remove an existing note while editing an answer", () => {
    let questionCalls = 0;
    let reviewCalls = 0;
    const select = vi.fn((_title: string, options: string[]) => {
      if (options.includes("Add a note")) return Promise.resolve(options[1]);
      if (options.includes("Remove note")) return Promise.resolve(options[2]);
      if (options.includes("Submit answers"))
        return Promise.resolve(reviewCalls++ === 0 ? options[1] : options[0]);
      return Promise.resolve(options[questionCalls++]);
    });
    const ui = {
      select,
      input: vi.fn(() => Promise.resolve("Remove this context.")),
      notify: vi.fn(),
    };

    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui })).then((outcome) => {
      expect(outcome).toEqual({
        outcome: "submitted",
        answers: [{ key: "library", kind: "choices", values: ["b"], labels: ["B"] }],
      });
    });
  });

  it("makes custom answers an explicit multi-select path", () => {
    const multiple: AskUserRequest = {
      questions: [{ ...request.questions[0]!, mode: "multiple" }],
    };
    let answerModes: string[] | undefined;
    const select = vi.fn((_title: string, options: string[]) => {
      if (options.includes("Choose listed options")) {
        answerModes = options;
        return Promise.resolve(options[1]);
      }
      if (options.includes("Continue without a note")) return Promise.resolve(options[0]);
      return Promise.resolve(options[0]);
    });
    const input = vi.fn(() => Promise.resolve("Use a hybrid instead."));
    const ui = { select, input, notify: vi.fn() };

    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui }), multiple).then((outcome) => {
      expect(outcome).toEqual({
        outcome: "submitted",
        answers: [{ key: "library", kind: "custom", text: "Use a hybrid instead." }],
      });
      expect(answerModes).toEqual(["Choose listed options", "Write a custom answer"]);
      expect(input).toHaveBeenCalledOnce();
    });
  });

  it("re-prompts mixed, nonnumeric, and out-of-range listed selections", () => {
    const multiple: AskUserRequest = {
      questions: [{ ...request.questions[0]!, mode: "multiple" }],
    };
    const input = vi
      .fn()
      .mockResolvedValueOnce("both")
      .mockResolvedValueOnce("1, custom")
      .mockResolvedValueOnce("5")
      .mockResolvedValueOnce("1,2");
    const notify = vi.fn();
    const select = vi.fn((_title: string, options: string[]) => {
      if (options.includes("Choose listed options")) return Promise.resolve(options[0]);
      if (options.includes("Continue without a note")) return Promise.resolve(options[0]);
      return Promise.resolve(options[0]);
    });
    const ui = { select, input, notify };

    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui }), multiple).then((outcome) => {
      expect(outcome).toMatchObject({
        outcome: "submitted",
        answers: [{ key: "library", values: ["a", "b"] }],
      });
      expect(input).toHaveBeenCalledTimes(4);
      expect(notify).toHaveBeenCalledTimes(3);
    });
  });

  it("preserves first-entered RPC choice order while deduplicating repeated values", () => {
    const multiple: AskUserRequest = {
      questions: [{ ...request.questions[0]!, mode: "multiple" }],
    };
    let reviewTitle: string | undefined;
    const select = vi.fn((title: string, options: string[]) => {
      if (options.includes("Choose listed options")) return Promise.resolve(options[0]);
      if (options.includes("Continue without a note")) return Promise.resolve(options[0]);
      if (options.includes("Submit answers")) reviewTitle = title;
      return Promise.resolve(options[0]);
    });
    const ui = {
      select,
      input: vi.fn(() => Promise.resolve("2,1,2,1")),
      notify: vi.fn(),
    };

    return run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui }), multiple).then((outcome) => {
      expect(outcome).toEqual({
        outcome: "submitted",
        answers: [{ key: "library", kind: "choices", values: ["b", "a"], labels: ["B", "A"] }],
      });
      expect(reviewTitle).toContain("B, A");
    });
  });

  effectIt.effect("fails closed when an RPC client returns an option that was not offered", () =>
    Effect.gen(function* () {
      for (const stage of ["answer-mode", "note", "review"] as const) {
        const multiple: AskUserRequest = {
          questions: [{ ...request.questions[0]!, mode: "multiple" }],
        };
        const select = vi.fn((_title: string, options: string[]) => {
          if (options.includes("Choose listed options"))
            return Promise.resolve(stage === "answer-mode" ? "unexpected option" : options[0]);
          if (options.includes("Continue without a note"))
            return Promise.resolve(stage === "note" ? "unexpected option" : options[0]);
          if (options.includes("Submit answers")) return Promise.resolve("unexpected option");
          return Promise.resolve(options[0]);
        });
        const ui = {
          select,
          input: vi.fn(() => Promise.resolve("1")),
          notify: vi.fn(),
        };
        const selectedRequest = stage === "answer-mode" ? multiple : request;

        yield* Effect.promise(() =>
          expect(
            run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui }), selectedRequest),
          ).resolves.toEqual({ outcome: "cancelled", answers: [] }),
        );
      }
    }),
  );

  it("cancels from review without leaking answers or notes", () => {
    const input = vi.fn(() => Promise.resolve("A private draft note."));
    const select = vi.fn((_title: string, options: string[]) => {
      if (options.includes("Add a note")) return Promise.resolve(options[1]);
      if (options.includes("Cancel questionnaire")) {
        return Promise.resolve(options[options.length - 1]);
      }
      return Promise.resolve(options[0]);
    });
    const ui = { select, input, notify: vi.fn() };

    return expect(run(opaqueHostFixture({ mode: "rpc", hasUI: true, ui }))).resolves.toEqual({
      outcome: "cancelled",
      answers: [],
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

  effectIt.effect("keeps normal dialog submission authoritative during cleanup", () =>
    Effect.gen(function* () {
      const bridge = makeAskUserDialogBridge();
      const done = vi.fn<(outcome: AskUserOutcome) => void>();
      const custom = vi.fn((factory: TestDialogFactory) => {
        const completed = controllable<AskUserOutcome>();
        const host = dialogFactoryHost();
        const keybindings: KeybindingsManager = opaqueHostFixture({
          matches: (data: string, id: string) => data === "\r" && id === "tui.select.confirm",
        });
        const component = factory(host.tui, host.theme, keybindings, (outcome) => {
          done(outcome);
          completed.resolve(outcome);
        });
        component.handleInput?.("1");
        component.handleInput?.("\r");
        return completed.promise;
      });
      const ctx = opaqueHostFixture({
        mode: "tui",
        hasUI: true,
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        ui: { custom },
      });

      const outcome = yield* Effect.promise(() => run(ctx, request, { bridge }));

      expect(outcome).toEqual({
        outcome: "submitted",
        answers: [{ key: "library", kind: "choices", values: ["a"], labels: ["A"] }],
      });
      expect(done).toHaveBeenCalledOnce();
      expect(done).toHaveBeenCalledWith(outcome);
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

  effectIt.effect("interrupts a nonsettling custom Promise and closes exactly once", () =>
    Effect.gen(function* () {
      const bridge = makeAskUserDialogBridge();
      const done = vi.fn<(outcome: AskUserOutcome) => void>();
      const custom = vi.fn((factory: TestDialogFactory) => {
        const host = dialogFactoryHost();
        factory(host.tui, host.theme, host.keybindings, done);
        return nonsettling<AskUserOutcome>();
      });
      const ctx = opaqueHostFixture({
        mode: "tui",
        hasUI: true,
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        ui: { custom },
      });
      const controller = new AbortController();
      const opening = run(ctx, request, { bridge, signal: controller.signal });

      yield* Effect.promise(() => vi.waitFor(() => expect(custom).toHaveBeenCalledOnce()));
      controller.abort();
      yield* Effect.promise(() => expect(opening).rejects.toBeDefined());

      expect(done).toHaveBeenCalledOnce();
      expect(done).toHaveBeenCalledWith({ outcome: "cancelled", answers: [] });
      expect(bridge.resume()).toBe(false);
    }),
  );

  effectIt.effect("clears only its bridge token when a replacement wins during the open", () =>
    Effect.gen(function* () {
      const bridge = makeAskUserDialogBridge();
      const done = vi.fn<(outcome: AskUserOutcome) => void>();
      const replacementResume = vi.fn();
      const custom = vi.fn((factory: TestDialogFactory) => {
        const host = dialogFactoryHost();
        factory(host.tui, host.theme, host.keybindings, done);
        bridge.activate(replacementResume);
        return nonsettling<AskUserOutcome>();
      });
      const ctx = opaqueHostFixture({
        mode: "tui",
        hasUI: true,
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        ui: { custom },
      });
      const controller = new AbortController();
      const opening = run(ctx, request, { bridge, signal: controller.signal });

      yield* Effect.promise(() => vi.waitFor(() => expect(custom).toHaveBeenCalledOnce()));
      controller.abort();
      yield* Effect.promise(() => expect(opening).rejects.toBeDefined());

      expect(done).toHaveBeenCalledOnce();
      expect(bridge.resume()).toBe(true);
      expect(replacementResume).toHaveBeenCalledOnce();
    }),
  );
});
