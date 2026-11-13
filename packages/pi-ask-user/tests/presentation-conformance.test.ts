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
import { registerAsyncAskUserTools } from "../src/tools/ask-user-async.ts";
import { renderAsyncMessage } from "../src/ui/async-tool-render.ts";
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
  const { tools } = captureRegistrations((pi) => {
    registerAskUserTool(pi, noExecution, scheduleAnimation);
    registerAsyncAskUserTools(pi, noExecution, noExecution, scheduleAnimation);
  });
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

const rowsOf = (text: string | undefined) =>
  Arr.filter(Str.split(text ?? "", "\n"), (row) => Str.isNonEmpty(Str.trim(row)));
const occurrences = (text: string, part: string) => Str.split(text, part).length - 1;
/** Where `part` first appears in `text`, or past its end when it doesn't. */
const position = (text: string, part: string) =>
  Option.getOrElse(Fn.pipe(text, Str.indexOf(part)), () => text.length);

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
        renderAsyncMessage(
          message,
          { ...keybindingHintsFixture, expanded: true, outputPad: 0 },
          theme,
        ).render(160),
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
          content: [{ type: "text" as const, text: `${entry.text}\nIndependent raw evidence` }],
        };
        for (const frame of harness.cycle(entry.args, result, { states: [false, true] }))
          for (const instruction of [
            "Do not",
            "Treat repeated",
            "Continue only",
            "Independent raw evidence",
          ])
            expect(frame.text).not.toContain(instruction);
      }
    },
  );

  describe("collapsed compact rows", () => {
    const ask = (
      questions: ReadonlyArray<{ readonly key: string; readonly title: string }>,
      answers: ReadonlyArray<{ readonly key: string; readonly text: string }>,
    ) => {
      const tool = Option.getOrThrow(
        Arr.findFirst(register("compact", "off").tools, (entry) => entry.name === "ask_user"),
      );
      const answered = {
        outcome: "submitted" as const,
        answers: Arr.map(answers, (answer) => ({ ...answer, kind: "text" as const })),
      };
      return createToolPresentationHarness(tool, { width: 140 }).cycle(
        {
          questions: Arr.map(questions, (question) => ({
            ...question,
            prompt: `${question.title}?`,
          })),
        },
        { details: answered, content: [{ type: "text", text: formatAskUserOutcome(answered) }] },
        { states: [false, true] },
      );
    };

    it("carries a lone short answer in its one row and shows it once expanded", () => {
      const [collapsed, expanded] = ask(
        [{ key: "colour", title: "Colour" }],
        [{ key: "colour", text: "Teal" }],
      );
      expect(rowsOf(collapsed?.text)).toHaveLength(1);
      expect(collapsed?.text).toContain("Teal");
      expect(occurrences(expanded?.text ?? "", "Teal")).toBe(1);
      expect(expanded?.text).toContain("Colour?");
    });

    it("counts several answers in its one row and shows each, after the questions, expanded", () => {
      const [collapsed, expanded] = ask(
        [
          { key: "colour", title: "Colour" },
          { key: "size", title: "Size" },
        ],
        [
          { key: "colour", text: "Teal" },
          { key: "size", text: "Large" },
        ],
      );
      expect(rowsOf(collapsed?.text)).toHaveLength(1);
      expect(collapsed?.text).not.toContain("Teal");
      const text = expanded?.text ?? "";
      for (const value of ["Teal", "Large"]) expect(occurrences(text, value)).toBe(1);
      expect(position(text, "Size?")).toBeLessThan(position(text, "Teal"));
    });

    it("keeps a status list to its heading, listing each questionnaire expanded", () => {
      const tool = Option.getOrThrow(
        Arr.findFirst(
          register("compact", "off").tools,
          (entry) => entry.name === "ask_user_async_control",
        ),
      );
      const open = {
        requestId: "request-open",
        deliveryId: "delivery-open",
        status: "pending" as const,
        delivery: "pending" as const,
        presentation: "open" as const,
        titles: [{ key: "colour", title: "Colour" }],
      };
      const done = { ...snapshot, titles: [{ key: "decision", title: "Scope" }] };
      const [collapsed, expanded] = createToolPresentationHarness(tool, { width: 140 }).cycle(
        { action: "status" },
        { details: { requests: [open, done] }, content: [{ type: "text", text: "status" }] },
        { states: [false, true] },
      );
      expect(rowsOf(collapsed?.text)).toHaveLength(1);
      const text = expanded?.text ?? "";
      // Each questionnaire is a listed row; Details key its IDs by the same name.
      for (const title of ["Colour", "Scope"])
        expect(Arr.filter(rowsOf(text), (row) => Fn.pipe(row, Str.includes(title)))).toHaveLength(
          2,
        );
      expect(text).toContain(open.requestId);
      // The heading counts what needs the user's input; no information line says it again.
      expect(text).not.toContain("ℹ");
    });
  });

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
