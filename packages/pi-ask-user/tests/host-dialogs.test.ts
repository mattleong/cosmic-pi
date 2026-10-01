import { cancelled, defaultQuestion, submitted } from "./support/questionnaire.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deferredPromise, opaqueFixture } from "pi-cosmic-core/testing";
import { makeTuiHost } from "./support/host.ts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { failureMessage } from "pi-cosmic-core";
import { makeAskUserHost } from "../src/boundary/host-dialogs.ts";
import type { AskUserHostError } from "../src/questionnaire/errors.ts";
import { makeAskUserDialogBridge, type AskUserDialogBridge } from "../src/boundary/host-ui.ts";
import type { AskUserAnswer, AskUserOutcome } from "../src/questionnaire/model.ts";
import { MAX_NOTE_LENGTH, type AskUserRequest } from "../src/questionnaire/schema.ts";

const request = {
  questions: [
    {
      ...defaultQuestion,
      key: "library",
      title: "Library",
      prompt: "Which library?",
    },
  ],
} satisfies AskUserRequest;
const multiple: AskUserRequest = { questions: [{ ...request.questions[0]!, mode: "multiple" }] };
const chooseB = {
  key: "library",
  kind: "choices",
  values: ["b"],
  labels: ["B"],
} satisfies AskUserAnswer;

const run = (
  ctx: ExtensionContext,
  selectedRequest: AskUserRequest = request,
  options?: { readonly bridge?: AskUserDialogBridge; readonly signal?: AbortSignal },
) =>
  Effect.runPromise(
    makeAskUserHost(ctx, options?.bridge ?? makeAskUserDialogBridge())(selectedRequest),
    options?.signal ? { signal: options.signal } : undefined,
  );

// Native RPC dialogs; members a test does not script are inert.
const rpc = <Ui extends object>(
  ui: Ui,
  selectedRequest: AskUserRequest = request,
  options?: Parameters<typeof run>[2],
) =>
  run(
    opaqueFixture({
      mode: "rpc",
      hasUI: true,
      ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn(), ...ui },
    }),
    selectedRequest,
    options,
  );

const scriptedSelect = (...indexes: number[]) => {
  let call = 0;
  return vi.fn((_title: string, options: string[], _opts?: { signal?: AbortSignal }) =>
    Promise.resolve(options.at(indexes[call++] ?? 0)),
  );
};

const textRequest: AskUserRequest = {
  questions: [{ key: "details", title: "Details", prompt: "Describe?", mode: "text" }],
};

describe("RPC questionnaire boundary", () => {
  it("asks text directly, retries invalid input and preserves notes through review edits", () => {
    const input = vi
      .fn()
      .mockResolvedValueOnce(" \n ")
      .mockResolvedValueOnce("x".repeat(4001))
      .mockResolvedValueOnce(" initial\nanswer ")
      .mockResolvedValueOnce(" context ")
      .mockResolvedValueOnce(" bq1234\nrevised ");
    const notify = vi.fn();
    return rpc({ input, select: scriptedSelect(1, 1, 0, 0), notify }, textRequest).then(
      (outcome) => {
        expect(outcome).toEqual(
          submitted({ key: "details", kind: "text", text: "bq1234\nrevised", note: "context" }),
        );
        expect(notify).toHaveBeenCalledTimes(2);
        expect(input.mock.calls.every((call) => call[2]?.signal instanceof AbortSignal)).toBe(true);
      },
    );
  });

  it.each(["input", "review"])("discards text when RPC %s is dismissed", (at) => {
    const select = at === "review" ? scriptedSelect(0, 99) : vi.fn();
    const input = vi.fn(() => Promise.resolve(at === "input" ? undefined : "draft"));
    return expect(rpc({ input, select }, textRequest)).resolves.toEqual(cancelled);
  });

  it("aborts a pending native text input without publishing drafts", () => {
    const entered = deferredPromise<AbortSignal>();
    const input = (_title: string, _placeholder: string, options: { signal: AbortSignal }) => {
      const answer = deferredPromise<string | undefined>();
      options.signal.addEventListener("abort", () => answer.resolve(undefined), { once: true });
      entered.resolve(options.signal);
      return answer.promise;
    };
    const select = vi.fn();
    const controller = new AbortController();
    const pending = rpc({ input, select }, textRequest, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBeDefined();
    return entered.promise.then((signal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      expect(select).not.toHaveBeenCalled();
      return rejected;
    });
  });
  it("uses interruption-linked native dialogs and returns stable values after review", () => {
    const select = scriptedSelect(1, 0, 0);
    return rpc({ select }).then((outcome) => {
      expect(outcome).toEqual(submitted(chooseB));
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
            return Effect.runPromise(Effect.never, opts?.signal ? { signal: opts.signal } : {});
          },
        );
        const controller = new AbortController();
        const pending = rpc({ select }, request, { signal: controller.signal });

        yield* Effect.promise(() =>
          vi.waitFor(() => expect(nativeSignal).toBeInstanceOf(AbortSignal)),
        );
        controller.abort();

        yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
        expect(nativeSignal?.aborted).toBe(true);
      }),
  );

  it.each([
    ["a dismissed RPC dialog", [99]],
    ["an explicit Cancel from review", [0, 1, -1]],
  ])("treats %s as cancellation without leaking answers or notes", (_, script) => {
    const input = vi.fn(() => Promise.resolve("A private draft note."));
    return expect(rpc({ select: scriptedSelect(...script), input })).resolves.toEqual(cancelled);
  });

  it("returns to single-select choices when the custom-answer input is dismissed", () => {
    const notify = vi.fn(() => {
      throw new Error("stale notification host");
    });
    const input = vi.fn(() => Promise.resolve(undefined));
    return rpc({ select: scriptedSelect(-1, 0, 0, 0), input, notify }).then((outcome) => {
      expect(outcome).toMatchObject({
        outcome: "submitted",
        answers: [{ key: "library", values: ["a"] }],
      });
      expect(notify).toHaveBeenCalledOnce();
    });
  });

  it("accepts an optional bounded note without changing the selected answer", () => {
    const tooLong = "x".repeat(MAX_NOTE_LENGTH + 1);
    const escape = String.fromCharCode(27);
    const note = `Why ${escape}[31mB${escape}[0m matters.`;
    const input = vi.fn().mockResolvedValueOnce(tooLong).mockResolvedValueOnce(note);
    let reviewTitle: string | undefined;
    let selectCall = 0;
    const select = vi.fn((title: string, options: string[]) => {
      const index = [1, 1, 0][selectCall++] ?? 0;
      if (selectCall === 3) reviewTitle = title;
      return Promise.resolve(options[index]);
    });
    const notify = vi.fn();

    return rpc({ select, input, notify }).then((outcome) => {
      expect(outcome).toEqual(submitted({ ...chooseB, note }));
      expect(reviewTitle).toBeDefined();
      expect(reviewTitle).not.toContain(escape);
      expect(input).toHaveBeenCalledTimes(2);
      expect(input.mock.calls.every((call) => call[2]?.signal instanceof AbortSignal)).toBe(true);
      expect(notify).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ["preserves", 0, { ...chooseB, note: "Existing context." }],
    ["removes", 2, chooseB],
  ] as const)(
    "reviews answers, edits a choice, and %s its existing note",
    (_, noteAction, answer) => {
      const input = vi.fn(() => Promise.resolve("Existing context."));
      return expect(
        rpc({ select: scriptedSelect(0, 1, 1, 1, noteAction, 0), input }),
      ).resolves.toEqual(submitted(answer));
    },
  );

  it("makes custom answers an explicit multi-select path", () => {
    const input = vi.fn(() => Promise.resolve("Use a hybrid instead."));
    return rpc({ select: scriptedSelect(1, 0, 0), input }, multiple).then((outcome) => {
      expect(outcome).toEqual(
        submitted({ key: "library", kind: "custom", text: "Use a hybrid instead." }),
      );
      expect(input).toHaveBeenCalledOnce();
    });
  });

  it("re-prompts mixed, nonnumeric, and out-of-range listed selections", () => {
    const input = vi
      .fn()
      .mockResolvedValueOnce("both")
      .mockResolvedValueOnce("1, custom")
      .mockResolvedValueOnce("5")
      .mockResolvedValueOnce("1,2");
    const notify = vi.fn();

    return rpc({ select: scriptedSelect(0, 0, 0), input, notify }, multiple).then((outcome) => {
      expect(outcome).toMatchObject({
        outcome: "submitted",
        answers: [{ key: "library", values: ["a", "b"] }],
      });
      expect(input).toHaveBeenCalledTimes(4);
      expect(notify).toHaveBeenCalledTimes(3);
      for (const call of notify.mock.calls)
        expect(issueMessageStyleProblems(String(call.at(0)))).toEqual([]);
    });
  });

  it("reports a failed native dialog in plain words without host details", () =>
    rpc({ select: vi.fn(() => Promise.reject(new Error("secret host failure"))) }).then(
      () => expect.unreachable(),
      (error: AskUserHostError) => {
        expect(error).toMatchObject({ _tag: "AskUserHostError", operation: "open" });
        expect(error.message).not.toContain("secret");
        expect(issueMessageStyleProblems(failureMessage(error.message, ""))).toEqual([]);
      },
    ));

  it("preserves first-entered RPC choice order while deduplicating repeated values", () => {
    const input = vi.fn(() => Promise.resolve("2,1,2,1"));
    return expect(rpc({ select: scriptedSelect(0, 0, 0), input }, multiple)).resolves.toEqual(
      submitted({ key: "library", kind: "choices", values: ["b", "a"], labels: ["B", "A"] }),
    );
  });

  effectIt.effect("fails closed when an RPC client returns an option that was not offered", () =>
    Effect.gen(function* () {
      for (const stage of ["answer-mode", "note", "review"] as const) {
        const invalidAt = { "answer-mode": 0, note: 1, review: 2 }[stage];
        let selectCall = 0;
        const select = vi.fn((_title: string, options: string[]) =>
          Promise.resolve(selectCall++ === invalidAt ? "unexpected option" : options[0]),
        );
        const input = vi.fn(() => Promise.resolve("1"));
        const selectedRequest = stage === "answer-mode" ? multiple : request;

        yield* Effect.promise(() =>
          expect(rpc({ select, input }, selectedRequest)).resolves.toEqual(cancelled),
        );
      }
    }),
  );
});

// Opens and mounts the real dialog, then lets the test decide how the custom Promise settles.
const mountOnCustom = (
  host: ReturnType<typeof makeTuiHost>,
  settle: (completed: Promise<AskUserOutcome>) => Promise<AskUserOutcome>,
) => {
  const open = host.ui.custom.getMockImplementation()!;
  host.ui.custom.mockImplementation((factory, options) => {
    const completed = open(factory, options);
    host.mount!();
    return settle(completed);
  });
};

describe("TUI questionnaire boundary", () => {
  effectIt.effect("stops an interrupted lazy open before settings or UI mutation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => import("../src/ui/dialog.ts"));
      const bridge = makeAskUserDialogBridge();
      const resume = vi.fn();
      bridge.activate(resume);
      const {
        ctx,
        ui: { custom },
      } = makeTuiHost();
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
      const host = makeTuiHost();
      mountOnCustom(host, (completed) => {
        host.component!.handleInput?.("1");
        host.component!.handleInput?.("\r");
        return completed;
      });

      const outcome = yield* Effect.promise(() => run(host.ctx, request, { bridge }));

      expect(outcome).toEqual(
        submitted({ key: "library", kind: "choices", values: ["a"], labels: ["A"] }),
      );
      expect(host.done).toHaveBeenCalledOnce();
      expect(host.done).toHaveBeenCalledWith(outcome);
      expect(bridge.resume()).toBe(false);
    }),
  );

  effectIt.effect("does not clear another bridge owner when custom rejects before activation", () =>
    Effect.gen(function* () {
      const bridge = makeAskUserDialogBridge();
      const resume = vi.fn();
      bridge.activate(resume);
      const {
        ctx,
        ui: { custom },
      } = makeTuiHost();
      custom.mockRejectedValue(new Error("custom unavailable"));

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

  effectIt.effect.each([
    ["closes exactly once", false],
    ["clears only its bridge token when a replacement wins during the open", true],
  ] as const)("interrupts a nonsettling custom Promise and %s", ([, replacement]) =>
    Effect.gen(function* () {
      const bridge = makeAskUserDialogBridge();
      const host = makeTuiHost();
      const replacementResume = vi.fn();
      mountOnCustom(host, () => {
        if (replacement) bridge.activate(replacementResume);
        return deferredPromise<AskUserOutcome>().promise;
      });
      const controller = new AbortController();
      const opening = run(host.ctx, request, { bridge, signal: controller.signal });

      yield* Effect.promise(() => vi.waitFor(() => expect(host.ui.custom).toHaveBeenCalledOnce()));
      controller.abort();
      yield* Effect.promise(() => expect(opening).rejects.toBeDefined());

      expect(host.done).toHaveBeenCalledOnce();
      expect(host.done).toHaveBeenCalledWith(cancelled);
      expect(bridge.resume()).toBe(replacement);
      expect(replacementResume).toHaveBeenCalledTimes(replacement ? 1 : 0);
    }),
  );
});
