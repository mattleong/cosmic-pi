import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { resolveCompactSummary, type CompactSummary } from "pi-code-previews";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";
import { projectBackgroundTaskPresentation } from "../src/code-mode/presentation.ts";
import { projectBackgroundTaskCodeModeOutput } from "../src/code-mode/output.ts";
import {
  BACKGROUND_TASK_PRESENTATION_VERSION,
  type BackgroundTaskCodeModeInput,
  type BackgroundTaskPresentation,
  normalizeBackgroundTaskCodeModeCapability,
  normalizeBackgroundTaskPresentation,
} from "../src/protocol.ts";

it("rejects inconsistent or older evidence and strips nonsemantic fields and controls", () => {
  for (const version of [1, 3])
    expect(
      normalizeBackgroundTaskPresentation({ version, incomplete: true, overflow: false }),
    ).toBeUndefined();
  expect(
    normalizeBackgroundTaskPresentation({ version: 2, incomplete: false, overflow: false }),
  ).toBeUndefined();
  expect(
    normalizeBackgroundTaskPresentation({ version: 2, incomplete: false, overflow: true }),
  ).toBeUndefined();
  const receipt = normalizeBackgroundTaskPresentation({
    version: 2,
    incomplete: false,
    overflow: false,
    raw: "private",
    summary: {
      action: "clear",
      subject: "\u001b[31mtask",
      outcome: "success",
      metadata: [],
      counters: [],
      issues: [],
      raw: "private",
    },
  });
  expect(receipt?.summary?.subject).toBe("task");
  expect(JSON.stringify(receipt)).not.toContain("private");
});

const args = { action: "logs" as const, id: "task-1" };
// Older persisted logs details carried `events: []` and Pi's full TruncationResult; both decode.
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
  expect(receipt.version).toBe(BACKGROUND_TASK_PRESENTATION_VERSION);
  expect(receipt.incomplete).toBe(false);
  expect(receipt.summary?.issues.map((issue) => issue.severity)).toEqual(["warning", "info"]);
  expect(receipt.summary?.outcome).toBe("warning");
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
  // The receipt summary is directly usable as a shared compact summary.
  const summary: CompactSummary | undefined = receipt.summary;
  expect(resolveCompactSummary(summary, "settled", false)).toEqual(summary);
});

it("keeps full task error text and marks excess evidence incomplete instead of clipping", () => {
  const task = { id: "task-1", command: "test", cwd: "/tmp", startedAt: 1, logCursor: 0 };
  const failed = { ...task, state: "failed", droppedLogBytes: 0, error: "x".repeat(2048) };
  const complete = projectBackgroundTaskPresentation(
    { action: "list" },
    { details: { action: "list", tasks: [failed] } },
  );
  expect(complete.incomplete).toBe(false);
  expect(complete.summary?.issues[0]?.detail).toBe(failed.error);
  // Each exited task contributes an issue; more than the receipt bound overflows.
  const exited = Array.from({ length: 33 }, (_, index) => ({
    ...task,
    id: `task-${index}`,
    state: "exited",
    exitCode: 1,
    droppedLogBytes: 0,
  }));
  expect(
    projectBackgroundTaskPresentation(
      { action: "list" },
      { details: { action: "list", tasks: exited } },
    ),
  ).toEqual({ version: 2, incomplete: true, overflow: true });
  // Details outside the task contract never reach a summary, so nothing overflowed.
  const oversizedId = projectBackgroundTaskPresentation(args, {
    details: { ...result.details, logs: { ...result.details.logs, id: "x".repeat(3000) } },
  });
  expect(oversizedId).toEqual({ version: 2, incomplete: true, overflow: false });
});

it("roundtrips issue detail while sanitizing messages and rejecting oversized issues", () => {
  const issue = {
    severity: "warning",
    code: "task-1:diagnostic",
    message: "\u001b[33mInspect\ntask",
    detail: "First line\nSecond line\u001b[0m",
    recovery: [{ code: "status", text: "Read status" }],
  };
  const input = {
    version: 2,
    incomplete: false,
    overflow: false,
    summary: {
      action: "status",
      subject: "task-1",
      outcome: "warning",
      metadata: [],
      counters: [],
      issues: [issue],
    },
  };
  const normalized = normalizeBackgroundTaskPresentation(input)?.summary?.issues[0];
  expect(normalized).toEqual({
    severity: "warning",
    code: "task-1:diagnostic",
    message: "Inspect task",
    detail: "First line\nSecond line",
  });
  const withIssues = (issues: ReadonlyArray<unknown>) =>
    normalizeBackgroundTaskPresentation({ ...input, summary: { ...input.summary, issues } });
  expect(withIssues([{ ...issue, detail: "x".repeat(2049) }])).toBeUndefined();
  expect(withIssues([{ ...issue, message: "x".repeat(241) }])).toBeUndefined();
  expect(withIssues(Array.from({ length: 33 }, () => issue))).toBeUndefined();
  expect(withIssues([{ ...issue, severity: "recovery" }])).toBeUndefined();
});

it.effect("keeps old providers and optional hostile acknowledgement compatible", () =>
  Effect.gen(function* () {
    const output = { action: "clear" as const, text: "clear", removed: 0 };
    let count = 0;
    const execute = (...values: unknown[]) => {
      count = values.length;
      return Promise.resolve(output);
    };
    const hostile = {
      version: 1,
      sessionId: "s",
      execute,
      get presentationVersion() {
        throw Error("optional getter");
      },
    };
    // A provider acknowledging only the older receipt never receives the observer.
    for (const raw of [hostile, { version: 1, sessionId: "s", execute, presentationVersion: 1 }]) {
      const provider = normalizeBackgroundTaskCodeModeCapability(raw)!;
      expect(provider.presentationVersion).toBeUndefined();
      let observed = false;
      count = 0;
      expect(
        yield* Effect.promise(() =>
          provider.execute("id", { action: "clear" }, new AbortController().signal, 1000, () => {
            observed = true;
          }),
        ),
      ).toBe(output);
      expect(count).toBe(4);
      expect(observed).toBe(false);
    }
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
        presentationVersion: BACKGROUND_TASK_PRESENTATION_VERSION,
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
      expect(provider.presentationVersion).toBe(BACKGROUND_TASK_PRESENTATION_VERSION);
      const seen: BackgroundTaskPresentation[] = [];
      const record = () =>
        provider.execute("id", { action: "clear" }, new AbortController().signal, 1000, (value) => {
          seen.push(value);
        });
      if (throws) expect(record).toThrow(failure);
      else yield* Effect.promise(record);
      expect(seen).toEqual([receipt]);
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
