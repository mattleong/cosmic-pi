import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  issueMessageStyleProblems,
} from "pi-code-previews/testing";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import {
  afterCursorAhead,
  BackgroundTaskCapacityError,
  BackgroundTerminationError,
  backgroundTaskNotFound,
  InvalidBackgroundCwdError,
} from "../src/task/errors.ts";
import type { BackgroundTaskServiceContract } from "../src/task/service.ts";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";
import { decodeBackgroundTaskFailure, failureIssue } from "../src/ui/result-facts.ts";
import { taskServiceDouble, taskServiceRunner, taskStatus } from "./support/task-service-double.ts";

const restoreSettings = applyPresentationSettings({});
afterEach(restoreSettings);

const ctx = extensionContextFixture({ cwd: "/project" });

const registeredTool = (service: Partial<BackgroundTaskServiceContract>) =>
  captureRegistrations((pi) =>
    registerBackgroundTaskTool(pi, { run: taskServiceRunner(taskServiceDouble(service)) }),
  ).tools[0]!;

const call = (input: BackgroundTaskToolInput, service: Partial<BackgroundTaskServiceContract>) =>
  Effect.promise(() => registeredTool(service).execute("call", input, undefined, undefined, ctx));

interface Case {
  readonly name: string;
  readonly input: BackgroundTaskToolInput;
  readonly service?: Partial<BackgroundTaskServiceContract>;
  // The exact text the model received when this failure was thrown.
  readonly text: string;
  readonly code: string;
  readonly facts: ReadonlyArray<string>;
  // Agent-facing wording the user view must not draw.
  readonly hidden: ReadonlyArray<string>;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "a cursor ahead of the task's output",
    input: { action: "logs", id: "task-0000000003", afterCursor: 40 },
    service: { logs: () => Effect.fail(afterCursorAhead("task-0000000003", 40, 12)) },
    text: "afterCursor is ahead of this task's output\nafterCursor 40 is ahead of task-0000000003's latest cursor 12; it may come from an earlier task with the same ID. Use 12 or less.",
    code: "cursor_ahead",
    facts: ["task-0000000003", "40", "12"],
    hidden: ["afterCursor is ahead", "Use 12 or less"],
  },
  {
    name: "an unknown task",
    input: { action: "status", id: "task-0000000042" },
    service: { status: (id) => Effect.fail(backgroundTaskNotFound(id)) },
    text: "Background task not found\nNo task has ID task-0000000042; it may have been cleared.",
    code: "not_found",
    facts: ["task-0000000042"],
    hidden: ["it may have been cleared"],
  },
  {
    name: "an argument the action does not accept",
    input: { action: "stop_all", id: "task-0000000003" },
    text: "The stop_all action does not accept id.",
    code: "unexpected_argument",
    facts: [],
    hidden: ["The stop_all action does not accept id"],
  },
  {
    name: "a missing argument",
    input: { action: "status" },
    text: "The status action requires id.",
    code: "missing_argument",
    facts: [],
    hidden: ["The status action requires id"],
  },
  {
    name: "arguments that conflict",
    input: { action: "logs", id: "task-0000000003", afterCursor: 1, tailLines: 5 },
    text: "The logs action accepts afterCursor or tailLines, not both.",
    code: "conflicting_arguments",
    facts: [],
    hidden: ["not both"],
  },
  {
    name: "a missing working directory",
    input: { action: "start", command: "pnpm dev", cwd: "apps/missing" },
    service: {
      start: (request) =>
        Effect.fail(
          InvalidBackgroundCwdError.make({
            cwd: request.cwd,
            message: `Couldn't find the working directory ${request.cwd}`,
          }),
        ),
    },
    text: "Couldn't find the working directory /project/apps/missing",
    code: "invalid_cwd",
    facts: ["/project/apps/missing"],
    hidden: [],
  },
  {
    name: "a full task capacity",
    input: { action: "start", command: "pnpm dev" },
    service: {
      start: () =>
        Effect.fail(
          BackgroundTaskCapacityError.make({
            limit: 4,
            message: "Background task capacity reached (4).",
          }),
        ),
    },
    text: "Background task capacity reached (4).",
    code: "capacity",
    facts: ["4"],
    hidden: ["capacity reached"],
  },
];

describe("expected background task failures", () => {
  for (const failure of cases)
    it.effect(`return ${failure.name} as a failed result with unchanged text`, () =>
      Effect.gen(function* () {
        const result = yield* call(failure.input, failure.service ?? {});
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: failure.text }]);
        expect(result).not.toHaveProperty("structuredContent");
        const decoded = Option.getOrUndefined(decodeBackgroundTaskFailure(result.details));
        expect(decoded?.failure.code).toBe(failure.code);
        if (decoded)
          expect(issueMessageStyleProblems(failureIssue(decoded.failure).message)).toEqual([]);

        for (const style of ["compact", "preview"] as const) {
          applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
          const harness = createToolPresentationHarness(registeredTool({}));
          const [collapsed, expanded] = harness.cycle(failure.input, result, {
            states: [false, true],
            overrides: () => ({ isError: true }),
          });
          const shown = Arr.join([collapsed?.text ?? "", expanded?.text ?? ""], "\n");
          for (const wording of failure.hidden) expect(shown).not.toContain(wording);
          for (const fact of failure.facts) expect(expanded?.text).toContain(fact);
          expect(Str.trim(collapsed?.text ?? "")).not.toBe("");
        }
      }),
    );

  it.effect("keeps a stop it couldn't confirm uncertain, not failed", () =>
    Effect.gen(function* () {
      const result = yield* call(
        { action: "stop", id: "task-0000000004" },
        {
          stop: (id) =>
            Effect.fail(
              BackgroundTerminationError.make({
                id,
                message: "Background process did not confirm exit after forced termination.",
              }),
            ),
        },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Background process did not confirm exit after forced termination.",
        },
      ]);
      const decoded = Option.getOrUndefined(decodeBackgroundTaskFailure(result.details));
      expect(decoded && failureIssue(decoded.failure).severity).toBe("warning");
    }),
  );

  it.effect("never draws the notify promise a start gives the agent", () =>
    Effect.gen(function* () {
      const input = { action: "start", command: "pnpm test", notify: "exit" } as const;
      const result = yield* call(input, {
        start: (request) =>
          Effect.succeed(taskStatus({ id: "task-0000000015", cwd: request.cwd, state: "running" })),
      });
      const [part] = result.content;
      const promise = Arr.last(Str.split(part?.type === "text" ? part.text : "", "\n"));
      expect(Option.isSome(promise)).toBe(true);
      for (const style of ["compact", "preview"] as const) {
        applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
        const harness = createToolPresentationHarness(registeredTool({}));
        for (const frame of harness.cycle(input, result, { states: [false, true] }))
          expect(frame.text).not.toContain(Option.getOrElse(promise, () => ""));
      }
    }),
  );
});
