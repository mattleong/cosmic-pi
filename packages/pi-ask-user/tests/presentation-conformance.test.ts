import type { CompactAnimationScheduler } from "pi-code-previews";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  probeAnimationOwnership,
} from "pi-code-previews/testing";
import { keybindingHintsFixture, plainTheme as theme } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import {
  registerAsyncAskUserMessageRenderer,
  registerAsyncAskUserTools,
  renderAskUserAsyncMessage,
} from "../src/tools/ask-user-async.ts";
import { formatAskUserOutcome, formatAsyncSnapshot } from "../src/questionnaire/format.ts";
import { noExecution } from "./support/questionnaire.ts";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const outcome = {
  outcome: "submitted",
  answers: [{ key: "decision", kind: "text", text: "Historical answer", note: "Retained note" }],
};
const snapshot = {
  requestId: "request-identity",
  deliveryId: "delivery-identity",
  status: "submitted",
  delivery: "sent",
  outcome,
};
function register(
  style: "compact" | "preview",
  mode?: "on" | "off" | "border",
  scheduleAnimation?: CompactAnimationScheduler,
) {
  applyPresentationSettings({
    toolCallCollapsedStyle: style,
    ...(mode && { toolCallBackground: mode }),
  });
  const { tools, messageRenderers } = captureRegistrations((pi) => {
    registerAskUserTool(pi, noExecution, scheduleAnimation);
    registerAsyncAskUserTools(pi, noExecution, noExecution, scheduleAnimation);
    registerAsyncAskUserMessageRenderer(pi);
  });
  expect([...messageRenderers.values()]).toEqual([renderAskUserAsyncMessage]);
  return { tools };
}
const restoreSettings = applyPresentationSettings({});
afterEach(restoreSettings);
const detailsFor = <Blocking, Row>(toolName: string, blocking: Blocking, row: Row) =>
  Match.value(toolName).pipe(
    Match.when("ask_user", () => blocking),
    Match.when("ask_user_async", () => row),
    Match.orElse(() => ({ requests: [row] })),
  );

describe("registered questionnaire presentation", () => {
  it("preserves answers and full call input, showing model text only without details", () => {
    const selected = {
      outcome: "submitted" as const,
      answers: [
        {
          key: "decision",
          kind: "choices" as const,
          values: ["ACTUAL_VALUE"],
          labels: ["Display label"],
          note: "Answer note",
        },
      ],
    };
    const row = {
      ...snapshot,
      status: "submitted" as const,
      delivery: "sent" as const,
      outcome: selected,
      independentWork: "Inspect",
      blockedWork: "Apply",
    };
    const questions = {
      questions: [
        {
          key: "decision",
          title: "Decision",
          prompt: "FULL_PROMPT_EVIDENCE",
          mode: "single",
          choices: [
            { value: "ACTUAL_VALUE", label: "Display label", description: "Selected choice" },
            { value: "other", label: "Other", description: "Alternative" },
          ],
        },
      ],
    };
    const { tools } = register("compact");
    for (const tool of tools) {
      const harness = createToolPresentationHarness(tool, { width: 160 });
      const isBlocking = tool.name === "ask_user";
      harness.call(
        Fn.pipe(tool.name, Str.endsWith("control"))
          ? { action: "status", requestId: row.requestId }
          : questions,
        { expanded: true },
      );
      harness.result(
        {
          details: detailsFor(tool.name, selected, row),
          content: [
            {
              type: "text",
              text:
                (isBlocking ? formatAskUserOutcome(selected) : formatAsyncSnapshot(row)) +
                "\nIndependent raw evidence",
            },
          ],
        },
        { expanded: true },
      );
      const text = Arr.join(harness.render(), "\n");
      expect(text).toContain("Display label");
      expect(text).toContain("Answer note");
      expect(text).not.toContain("Independent raw evidence");
      if (!Fn.pipe(tool.name, Str.endsWith("control")))
        expect(text).toContain("FULL_PROMPT_EVIDENCE");
      else expect(text).toContain(row.requestId);
      harness.result(
        { details: {}, content: [{ type: "text", text: "Independent raw evidence" }] },
        { expanded: true },
      );
      expect(Arr.join(harness.render(), "\n")).toContain("Independent raw evidence");
    }
    const message = {
      role: "custom" as const,
      customType: "pi-ask-user-async-answer",
      content: formatAskUserOutcome(selected),
      display: true,
      timestamp: 0,
      details: {
        requestId: row.requestId,
        deliveryId: row.deliveryId,
        generation: "generation",
        outcome: selected,
      },
    };
    expect(
      Arr.join(
        renderAskUserAsyncMessage(
          message,
          { ...keybindingHintsFixture, expanded: true, outputPad: 0 },
          theme,
        )!.render(160),
        "\n",
      ),
    ).toContain("Display label");
  });
  it.each(["compact", "preview"] as const)(
    "never draws the instructions results give the agent in %s style",
    (style) => {
      const pending = {
        requestId: "request-pending",
        deliveryId: "delivery-pending",
        status: "pending" as const,
        delivery: "pending" as const,
        presentation: "queued" as const,
        independentWork: "Inspect",
        blockedWork: "Apply",
      };
      const failed = { ...pending, status: "submitted" as const, delivery: "failed" as const };
      const cancelled = { outcome: "cancelled" as const, answers: [] as const };
      const cases = [
        {
          name: "ask_user",
          args: { questions: [] },
          details: cancelled,
          text: formatAskUserOutcome(cancelled),
        },
        {
          name: "ask_user_async",
          args: { questions: [] },
          details: pending,
          text: formatAsyncSnapshot(pending),
        },
        {
          name: "ask_user_async_control",
          args: { action: "status", requestId: failed.requestId },
          details: { requests: [{ ...failed, outcome }] },
          text: formatAsyncSnapshot({ ...failed, outcome: { outcome: "submitted", answers: [] } }),
        },
      ];
      const { tools } = register(style);
      for (const tool of tools) {
        const entry = Arr.findFirst(cases, (candidate) => candidate.name === tool.name).pipe(
          Option.getOrThrow,
        );
        const harness = createToolPresentationHarness(tool, { width: 160 });
        const result = {
          details: entry.details,
          content: [{ type: "text" as const, text: entry.text }],
        };
        for (const frame of harness.cycle(entry.args, result, { states: [false, true] }))
          for (const instruction of ["Do not", "Treat repeated", "Retrieve the", "Continue only"])
            expect(frame.text).not.toContain(instruction);
      }
    },
  );

  it.each([57, 100])(
    "names a collapsed preview row's hidden answer lines in its heading tag at %i columns",
    (width) => {
      const answered = {
        outcome: "submitted" as const,
        answers: [
          { key: "summary", kind: "text" as const, text: "First line\nHIDDEN_SECOND_LINE" },
        ],
      };
      const { tools } = register("preview", "off");
      const tool = Option.getOrThrow(Arr.findFirst(tools, (entry) => entry.name === "ask_user"));
      const harness = createToolPresentationHarness(tool, { width });
      harness.call({ questions: [{ key: "summary", title: "Summary", prompt: "Describe it" }] });
      harness.result({
        details: answered,
        content: [{ type: "text", text: formatAskUserOutcome(answered) }],
      });
      const [heading = "", ...body] = harness.render(width);
      // The heading's tag offers the rest; the body draws no affordance line of its own.
      expect(heading).toContain("▸");
      expect(Arr.some(body, (row) => Fn.pipe(row, Str.trim, Str.startsWith("▸")))).toBe(false);
      const text = Arr.join(body, "\n");
      expect(text).toContain("First line");
      expect(text).not.toContain("HIDDEN_SECOND_LINE");
    },
  );

  it.each([57, 100])(
    "leaves a lone answer's label to a preview heading that shows its whole title at %i columns",
    (width) => {
      const { tools } = register("preview", "off");
      const tool = Option.getOrThrow(Arr.findFirst(tools, (entry) => entry.name === "ask_user"));
      const answerBody = (
        questions: ReadonlyArray<{ readonly key: string; readonly title: string }>,
        answers: ReadonlyArray<{
          readonly key: string;
          readonly text: string;
          readonly note?: string;
        }>,
      ) => {
        const answered = {
          outcome: "submitted" as const,
          answers: Arr.map(answers, (answer) => ({ ...answer, kind: "text" as const })),
        };
        const harness = createToolPresentationHarness(tool, { width });
        harness.call({
          questions: Arr.map(questions, (question) => ({ ...question, prompt: "?" })),
        });
        harness.result({
          details: answered,
          content: [{ type: "text", text: formatAskUserOutcome(answered) }],
        });
        const [, ...body] = harness.render(width);
        return Arr.join(body, "\n");
      };
      const lone = answerBody(
        [{ key: "env", title: "Environment" }],
        [{ key: "env", text: "Staging", note: "Watch the logs" }],
      );
      expect(lone).toContain("Staging");
      expect(lone).not.toContain("Environment:");
      // A note keeps its own label.
      expect(lone).toContain("Note:");
      // Several answers, or a title the heading had to cut, keep their labels.
      expect(
        answerBody(
          [
            { key: "env", title: "Environment" },
            { key: "lib", title: "Library" },
          ],
          [
            { key: "env", text: "Staging" },
            { key: "lib", text: "Intl" },
          ],
        ),
      ).toContain("Environment:");
      const long = "Deployment environment for the first release";
      expect(answerBody([{ key: "env", title: long }], [{ key: "env", text: "Staging" }])).toMatch(
        /: Staging/u,
      );
    },
  );

  it("uses the registering owner's scheduler and releases it when the call settles", () => {
    const scheduler = animationSchedulerProbe();
    applyPresentationSettings({ toolCallTiming: false });
    const report = probeAnimationOwnership(
      register("compact", undefined, scheduler.schedule).tools,
      scheduler,
      {
        args: (tool) =>
          tool.name === "ask_user_async_control"
            ? { action: "await", requestId: "request-1" }
            : { questions: [{ title: "Library" }] },
      },
    );
    for (const { scheduled, invalidated, stops } of report) {
      expect(scheduled).toBeGreaterThan(0);
      expect(invalidated).toBe(true);
      expect(stops).toBeGreaterThan(0);
    }
  });
});
