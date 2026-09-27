import type { CompactAnimationScheduler } from "pi-code-previews";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  probeAnimationOwnership,
} from "pi-code-previews/testing";
import { opaqueFixture as fixture, plainTheme as theme } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import { registerAsyncAskUserTools } from "../src/tools/ask-user-async.ts";
import { formatAskUserOutcome, formatAsyncSnapshot } from "../src/questionnaire/format.ts";

const args = {
  questions: [{ key: "decision", title: "Decision", prompt: "Explain", mode: "text" }],
};
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
const noExecution = () => {
  throw new Error("Rendering must not execute");
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
  });
  return { tools, messages: [...messageRenderers.values()] };
}
const restoreSettings = applyPresentationSettings({});
afterEach(restoreSettings);
/** The settled details each registered tool reports for one questionnaire. */
const detailsFor = <Blocking, Row>(toolName: string, blocking: Blocking, row: Row) =>
  toolName === "ask_user" ? blocking : toolName === "ask_user_async" ? row : { requests: [row] };

describe("registered questionnaire presentation", () => {
  it.each(["compact", "preview"] as const)(
    "retains answer content through %s expansion toggles",
    (style) => {
      const { tools } = register(style);
      for (const tool of tools) {
        const harness = createToolPresentationHarness(tool, { width: 160 });
        const details = detailsFor(tool.name, outcome, snapshot);
        const result = { details, content: [{ type: "text" as const, text: "Historical answer" }] };
        const before = structuredClone(result);
        for (const expanded of [false, true, false, true]) {
          harness.call(
            tool.name.endsWith("control")
              ? { action: "status", requestId: snapshot.requestId }
              : args,
            { expanded },
          );
          harness.result(result, { expanded });
          const text = harness.render().join("\n");
          if (expanded || style === "preview") expect(text).toContain("Historical answer");
          else expect(text).not.toContain("Historical answer");
          harness.invalidate();
        }
        expect(result).toEqual(before);
      }
    },
  );

  it("preserves choice values, full call input, and independent raw evidence", () => {
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
    const { tools, messages } = register("compact");
    for (const tool of tools) {
      const harness = createToolPresentationHarness(tool, { width: 160 });
      const isBlocking = tool.name === "ask_user";
      harness.call(
        tool.name.endsWith("control") ? { action: "status", requestId: row.requestId } : questions,
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
      const text = harness.render().join("\n");
      expect(text).toContain("ACTUAL_VALUE");
      expect(text).toContain("Answer note");
      expect(text).toContain("Independent raw evidence");
      if (!tool.name.endsWith("control")) expect(text).toContain("FULL_PROMPT_EVIDENCE");
    }
    const message = {
      customType: "pi-ask-user-async-answer",
      content: formatAskUserOutcome(selected),
      details: {
        requestId: row.requestId,
        deliveryId: row.deliveryId,
        generation: "generation",
        outcome: selected,
      },
    };
    expect(
      messages[0]!(fixture(message), { expanded: true, outputPad: 0 }, theme)!
        .render(160)
        .join("\n"),
    ).toContain("ACTUAL_VALUE");
  });

  it("groups compact attention for distinct pending requests and failed deliveries", () => {
    const pending = ["request-a", "request-b", "request-c"].map((requestId) => ({
      requestId,
      deliveryId: `delivery-${requestId}`,
      status: "pending" as const,
      delivery: "pending" as const,
      presentation: "open" as const,
    }));
    const failures = ["request-a", "request-b"].map((requestId) => ({
      requestId,
      deliveryId: `delivery-${requestId}`,
      status: "submitted" as const,
      delivery: "failed" as const,
      outcome,
    }));
    for (const mode of ["on", "off", "border"] as const) {
      const tool = register("compact", mode).tools.find(
        (entry) => entry.name === "ask_user_async_control",
      )!;
      for (const [rows, message, procedure, routine] of [
        [
          pending,
          "3 questionnaires are waiting for answers",
          "Continue only independent work",
          true,
        ],
        [
          failures,
          "Automatic delivery failed for 2 saved questionnaire results",
          "Retrieve the retained result",
          false,
        ],
      ] as const) {
        const result = {
          details: { requests: rows },
          content: [{ type: "text" as const, text: "Independent raw result marker" }],
        };
        const before = structuredClone(result);
        const harness = createToolPresentationHarness(tool, { width: 200 });
        for (const expanded of [false, true, false, true]) {
          harness.call({ action: "status" }, { expanded });
          harness.result(result, { expanded });
          const text = harness.render().join("\n");
          // One grouped fact; routine waiting shows it only on expansion, like its procedure.
          expect(text.split(message)).toHaveLength(!routine || expanded ? 2 : 1);
          expect(text.split(procedure)).toHaveLength(expanded ? 2 : 1);
          expect(text.includes("Independent raw result marker")).toBe(expanded);
          for (const row of rows) expect(text.includes(row.requestId)).toBe(expanded);
        }
        expect(result).toEqual(before);
      }
    }
  });

  it("describes failed answer delivery without showing agent procedures or identities", () => {
    const tool = register("compact").tools.find(
      (entry) => entry.name === "ask_user_async_control",
    )!;
    const harness = createToolPresentationHarness(tool, { width: 200 });
    const result = {
      details: { ...snapshot, delivery: "failed" },
      content: [{ type: "text" as const, text: "AGENT_DELIVERY_PROCEDURE" }],
    };
    const before = structuredClone(result);
    for (const expanded of [false, true, false]) {
      harness.call({ action: "status", requestId: snapshot.requestId }, { expanded });
      harness.result(result, { expanded });
      const text = harness.render().join("\n");
      expect(text.includes("AGENT_DELIVERY_PROCEDURE")).toBe(expanded);
      expect(
        !expanded && /request-identity|delivery-identity|Retrieve the retained/.test(text),
      ).toBe(false);
      expect(/saved.*delivery failed/i.test(text)).toBe(true);
      expect(text.includes("Retrieve the retained")).toBe(expanded);
      expect(result).toEqual(before);
    }
  });

  it("retains raw malformed failures and cancellation guidance", () => {
    for (const tool of register("compact").tools) {
      const harness = createToolPresentationHarness(tool);
      harness.call(args, { expanded: true });
      harness.result(
        {
          details: { malformed: true },
          content: [{ type: "text", text: "Failure recovery remains available" }],
        },
        { expanded: true, isError: true },
      );
      expect(harness.render().join("\n")).toContain("Failure recovery remains available");
      const cancelled = { outcome: "cancelled", answers: [] };
      const row = { ...snapshot, status: "cancelled", outcome: cancelled };
      harness.result(
        {
          details: detailsFor(tool.name, cancelled, row),
          content: [],
        },
        { expanded: true, isError: true },
      );
      expect(harness.render().join("\n")).toContain("Do not immediately ask");
    }
  });

  it("renders owned async messages with padding, private answers on expansion, and unchanged identity", () => {
    const renderer = register("compact").messages[0]!;
    const message = {
      customType: "pi-ask-user-async-answer",
      content: "",
      details: {
        requestId: snapshot.requestId,
        deliveryId: snapshot.deliveryId,
        generation: "historical-generation",
        outcome,
      },
    };
    for (const expanded of [false, true, false]) {
      const text = renderer(fixture(message), { expanded, outputPad: 2 }, theme)!
        .render(100)
        .join("\n");
      expect(text.includes("Historical answer")).toBe(expanded);
      expect(text.includes("Retained note")).toBe(expanded);
      expect(text.includes("historical-generation")).toBe(expanded);
      expect(text.startsWith("  ")).toBe(true);
    }
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
