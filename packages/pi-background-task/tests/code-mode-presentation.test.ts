import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  backgroundTaskCompactSummary,
  projectBackgroundTaskCompactSummary,
} from "../src/ui/compact-summary.ts";
import { projectBackgroundTaskPresentation } from "../src/code-mode/presentation.ts";
import { projectBackgroundTaskCodeModeOutput } from "../src/code-mode/output.ts";
import {
  type BackgroundTaskCodeModeInput,
  type BackgroundTaskPresentation,
  normalizeBackgroundTaskCodeModeCapability,
  normalizeBackgroundTaskPresentation,
} from "../src/protocol.ts";

it("rejects inconsistent evidence and strips nonsemantic fields and terminal controls", () => {
  expect(
    normalizeBackgroundTaskPresentation({ version: 2, incomplete: true, overflow: false }),
  ).toBeUndefined();
  expect(
    normalizeBackgroundTaskPresentation({ version: 1, incomplete: false, overflow: false }),
  ).toBeUndefined();
  expect(
    normalizeBackgroundTaskPresentation({ version: 1, incomplete: false, overflow: true }),
  ).toBeUndefined();
  const receipt = normalizeBackgroundTaskPresentation({
    version: 1,
    incomplete: false,
    overflow: false,
    raw: "private",
    summary: {
      action: "clear",
      subject: "\u001b[31mtask",
      outcome: "success",
      metadata: [],
      counters: [],
      notices: [],
      detailsOnExpand: true,
      raw: "private",
    },
  });
  expect(receipt?.summary?.subject).toBe("task");
  expect(JSON.stringify(receipt)).not.toContain("private");
});

const args = { action: "logs" as const, id: "task-1" };
const result = {
  text: "private log text",
  details: {
    action: "logs" as const,
    logs: {
      id: "task-1",
      events: [],
      state: "running" as const,
      nextCursor: 10,
      earliestAvailableCursor: 0,
      droppedBytes: 0,
    },
    truncation: {
      content: "private log text",
      truncatedBy: "bytes" as const,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: 1,
      maxBytes: 10,
      truncated: true,
      outputBytes: 10,
      totalBytes: 20,
      outputLines: 1,
      totalLines: 2,
    },
  },
};

it("preserves original truncation independently of unchanged guest data", () => {
  const receipt = projectBackgroundTaskPresentation(args, result);
  expect(receipt.incomplete).toBe(false);
  expect(receipt.summary?.notices.map((notice) => notice.kind)).toEqual(["warning", "recovery"]);
  expect(receipt.summary?.outcome).toBe("warning");
  expect(receipt.summary?.issues?.coverage).toBe("complete");
  expect(receipt.summary?.issues?.entries.length).toBeGreaterThan(0);
  expect(JSON.stringify(receipt)).not.toContain(result.text);
  const guest = projectBackgroundTaskCodeModeOutput(result, 4096);
  expect(guest._tag).toBe("Accepted");
  if (guest._tag === "Accepted") expect(guest.output).not.toHaveProperty("truncation");
  const pure = projectBackgroundTaskCompactSummary({
    phase: "settled",
    args,
    result,
    isError: false,
  });
  expect(receipt.summary?.issues).toEqual(pure?.issues);
  const standalone = backgroundTaskCompactSummary({
    phase: "settled",
    args,
    result: { ...result, content: [] },
    context: {
      args,
      state: {},
      toolCallId: "test",
      cwd: "/",
      invalidate() {},
      lastComponent: undefined,
      argsComplete: true,
      executionStarted: true,
      expanded: false,
      isPartial: false,
      isError: false,
      showImages: true,
    },
  });
  expect(pure).toEqual(standalone);
  // The v1 receipt retains the legacy notice contract, not the new semantic identities.
  expect(receipt.summary?.notices).toEqual(
    pure?.notices?.map(({ kind, text }) => ({ kind, text })),
  );
});

it("marks oversized semantic evidence incomplete instead of silently clipping", () => {
  const receipt = projectBackgroundTaskPresentation(args, {
    details: { ...result.details, logs: { ...result.details.logs, id: "x".repeat(3000) } },
  });
  expect(receipt).toEqual({ version: 1, incomplete: true, overflow: true });
});

it.effect("keeps old providers and optional hostile acknowledgement compatible", () =>
  Effect.gen(function* () {
    const output = { action: "clear" as const, text: "clear", removed: 0 };
    let count = 0;
    const raw = {
      version: 1,
      sessionId: "s",
      execute(...values: unknown[]) {
        count = values.length;
        return Promise.resolve(output);
      },
      get presentationVersion() {
        throw Error("optional getter");
      },
    };
    const provider = normalizeBackgroundTaskCodeModeCapability(raw)!;
    let observed = false;
    expect(
      yield* Effect.promise(() =>
        provider.execute("id", { action: "clear" }, new AbortController().signal, 1000, () => {
          observed = true;
        }),
      ),
    ).toBe(output);
    expect(count).toBe(4);
    expect(observed).toBe(false);
  }),
);

it.effect("contains observer failures without changing returned values or execution throws", () =>
  Effect.gen(function* () {
    const output = { action: "clear" as const, text: "clear", removed: 0 };
    const receipt = projectBackgroundTaskPresentation({ action: "clear" }, { details: output });
    const failure = new Error("execution failure");
    for (const throws of [false, true]) {
      const provider = normalizeBackgroundTaskCodeModeCapability({
        version: 1,
        presentationVersion: 1,
        sessionId: "s",
        execute(
          _id: string,
          _input: BackgroundTaskCodeModeInput,
          _signal: AbortSignal,
          _max: number,
          observe: (value: BackgroundTaskPresentation) => void,
        ) {
          observe(receipt);
          if (throws) throw failure;
          return Promise.resolve(output);
        },
      })!;
      for (const observer of [
        () => {
          throw Error("observer");
        },
        () => Promise.reject(Error("observer")),
      ]) {
        const run = () =>
          provider.execute("id", { action: "clear" }, new AbortController().signal, 1000, observer);
        if (throws) expect(run).toThrow(failure);
        else expect(yield* Effect.promise(run)).toBe(output);
      }
    }
  }),
);
