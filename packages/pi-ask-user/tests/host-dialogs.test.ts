import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it, vi } from "vitest";
import { HostDialogs } from "../src/boundary/host-dialogs.ts";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";
import type { AskUserRequest } from "../src/tools/schema.ts";

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

const run = (ctx: ExtensionContext, selectedRequest: AskUserRequest = request) => {
  const runtime = ManagedRuntime.make(HostDialogs.layer(ctx, makeAskUserDialogBridge()));
  return runtime
    .runPromise(Effect.flatMap(HostDialogs, (host) => host.ask(selectedRequest)))
    .finally(() => runtime.dispose());
};

describe("RPC questionnaire boundary", () => {
  it("uses native select and returns stable values", () => {
    const select = vi.fn((_title: string, options: string[], _opts?: { signal?: AbortSignal }) =>
      Promise.resolve(options[1]),
    );
    const ui = { select, input: vi.fn(), notify: vi.fn() } as unknown as ExtensionUIContext;
    const ctx = { mode: "rpc", hasUI: true, ui } as ExtensionContext;

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
    } as unknown as ExtensionUIContext;
    return expect(run({ mode: "rpc", hasUI: true, ui } as ExtensionContext)).resolves.toEqual({
      outcome: "cancelled",
      answers: [],
    });
  });

  it("returns to single-select choices when the custom-answer input is dismissed", () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("3. Write a custom answer")
      .mockResolvedValueOnce("1. A — Choose A.");
    const notify = vi.fn();
    const ui = {
      select,
      input: vi.fn(() => Promise.resolve(undefined)),
      notify,
    } as unknown as ExtensionUIContext;
    return run({ mode: "rpc", hasUI: true, ui } as ExtensionContext).then((outcome) => {
      expect(outcome).toMatchObject({
        outcome: "submitted",
        answers: [{ key: "library", values: ["a"] }],
      });
      expect(select).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("dismissed"), "info");
    });
  });

  it("re-prompts all-numeric multi-select values that are out of range", () => {
    const multiple: AskUserRequest = {
      questions: [{ ...request.questions[0]!, mode: "multiple" }],
    };
    const input = vi.fn().mockResolvedValueOnce("5").mockResolvedValueOnce("1,2");
    const notify = vi.fn();
    const ui = { select: vi.fn(), input, notify } as unknown as ExtensionUIContext;
    return run({ mode: "rpc", hasUI: true, ui } as ExtensionContext, multiple).then((outcome) => {
      expect(outcome).toMatchObject({
        outcome: "submitted",
        answers: [{ key: "library", values: ["a", "b"] }],
      });
      expect(input).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledWith("Use choice numbers from 1 to 2.", "warning");
    });
  });
});
