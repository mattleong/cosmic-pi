import { cancelled, defaultQuestion, submitted } from "./support/questionnaire.ts";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { deferredPromise, extensionContextFixture } from "pi-cosmic-core/testing";
import { eventually, makeTuiHost } from "./support/host.ts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { failureMessage } from "pi-cosmic-core";
import { askUserHost } from "../src/boundary/host-dialogs.ts";
import { AskUserHostError } from "../src/questionnaire/errors.ts";
import { createAskUserDialogBridge, type AskUserDialogBridge } from "../src/boundary/host-ui.ts";
import type { AskUserAnswer } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

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
    askUserHost(ctx, options?.bridge ?? createAskUserDialogBridge())(selectedRequest),
    options?.signal ? { signal: options.signal } : undefined,
  );

const rpc = (
  ui: Partial<ExtensionUIContext>,
  selectedRequest: AskUserRequest = request,
  options?: Parameters<typeof run>[2],
) =>
  run(
    extensionContextFixture({
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

describe("RPC questionnaire boundary", () => {
  it("uses interruption-linked native dialogs and returns stable values after review", () => {
    const select = scriptedSelect(1, 0, 0);
    return rpc({ select }).then((outcome) => {
      expect(outcome).toEqual(submitted(chooseB));
      expect(select).toHaveBeenCalledTimes(3);
      expect(select.mock.calls.every((call) => call[2]?.signal instanceof AbortSignal)).toBe(true);
      return undefined;
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

        yield* eventually(() => expect(nativeSignal).toBeInstanceOf(AbortSignal));
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

  it("reopens a too-long typed answer with its text so the user can trim it", () => {
    const tooLong = "Keep this wording. ".repeat(220);
    const trimmed = "Keep this wording.";
    const input = vi.fn(() => Promise.resolve(tooLong));
    const editor = vi.fn((_title: string, _prefill?: string) => Promise.resolve(trimmed));
    const wording: AskUserRequest = {
      questions: [{ key: "wording", title: "Wording", prompt: "What wording?", mode: "text" }],
    };
    return rpc({ select: scriptedSelect(0, 0), input, editor }, wording).then((outcome) => {
      expect(outcome).toEqual(submitted({ key: "wording", kind: "text", text: trimmed }));
      expect(input).toHaveBeenCalledOnce();
      expect(editor).toHaveBeenCalledOnce();
      expect(editor.mock.calls[0]?.[1]).toBe(tooLong);
      return undefined;
    });
  });

  effectIt.effect("settles an interrupted questionnaire while the trimming editor is open", () =>
    Effect.gen(function* () {
      const editor = vi.fn(() => deferredPromise<string | undefined>().promise);
      const input = vi.fn(() => Promise.resolve("x".repeat(4_001)));
      const controller = new AbortController();
      const pending = rpc({ select: scriptedSelect(2), input, editor }, request, {
        signal: controller.signal,
      });

      yield* eventually(() => expect(editor).toHaveBeenCalledOnce());
      controller.abort();
      yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    }),
  );

  it("reports a failed native dialog in plain words without host details", () =>
    rpc({ select: vi.fn(() => Promise.reject(new Error("secret host failure"))) }).then(
      () => expect.unreachable(),
      (cause: unknown) => {
        if (!(cause instanceof AskUserHostError)) throw cause;
        expect(cause.operation).toBe("open");
        expect(cause.message).not.toContain("secret");
        expect(issueMessageStyleProblems(failureMessage(cause.message, ""))).toEqual([]);
      },
    ));
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

describe("TUI questionnaire boundary", () => {
  effectIt.effect("stops an interrupted lazy open before settings or UI mutation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => import("../src/ui/dialog.ts"));
      const bridge = createAskUserDialogBridge();
      const resume = vi.fn();
      bridge.activate(resume);
      const host = makeTuiHost();
      const controller = new AbortController();

      const opening = run(host.ctx, request, { bridge, signal: controller.signal });
      controller.abort();
      yield* Effect.promise(() => expect(opening).rejects.toBeDefined());

      expect(host.customCalls).toBe(0);
      expect(bridge.resume()).toBe(true);
      expect(resume).toHaveBeenCalledOnce();
    }),
  );

  effectIt.effect.each([
    ["closes exactly once", false],
    ["clears only its bridge token when a replacement wins during the open", true],
  ] as const)("interrupts a nonsettling custom Promise and %s", ([, replacement]) =>
    Effect.gen(function* () {
      const bridge = createAskUserDialogBridge();
      const host = makeTuiHost();
      const replacementResume = vi.fn();
      host.settleOnOpen(() => {
        if (replacement) bridge.activate(replacementResume);
        return deferredPromise<never>().promise;
      });
      const controller = new AbortController();
      const opening = run(host.ctx, request, { bridge, signal: controller.signal });

      yield* eventually(() => expect(host.customCalls).toBe(1));
      controller.abort();
      yield* Effect.promise(() => expect(opening).rejects.toBeDefined());

      expect(host.done).toHaveBeenCalledOnce();
      expect(host.done).toHaveBeenCalledWith(cancelled);
      expect(bridge.resume()).toBe(replacement);
      expect(replacementResume).toHaveBeenCalledTimes(replacement ? 1 : 0);
    }),
  );
});
