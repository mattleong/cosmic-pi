import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodePreviewSettings } from "../../pi-code-previews/src/config/defaults.ts";
import { setCodePreviewSettings } from "../../pi-code-previews/src/config/state.ts";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import { registerAsyncAskUserTools } from "../src/tools/ask-user-async.ts";
import { formatAskUserOutcome, formatAsyncSnapshot } from "../src/questionnaire/format.ts";

// SAFETY: Fixtures implement only the registration and theme methods exercised by rendering.
const fixture = <T>(value: T): never => value as never;
const theme: Theme = fixture({
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
});
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
function register(style: "compact" | "preview") {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallCollapsedStyle: style });
  const tools: ToolDefinition[] = [];
  const messages: Parameters<ExtensionAPI["registerMessageRenderer"]>[1][] = [];
  const pi: ExtensionAPI = fixture({
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerMessageRenderer: (
      _name: string,
      render: Parameters<ExtensionAPI["registerMessageRenderer"]>[1],
    ) => messages.push(render),
  });
  registerAskUserTool(pi, noExecution);
  registerAsyncAskUserTools(pi, noExecution, noExecution);
  return { tools, messages };
}
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

describe("registered questionnaire presentation", () => {
  it.each(["compact", "preview"] as const)(
    "retains answer content through %s expansion toggles",
    (style) => {
      const { tools } = register(style);
      for (const tool of tools) {
        const harness = createToolPresentationHarness(tool, { theme, width: 160 });
        const details =
          tool.name === "ask_user"
            ? outcome
            : tool.name === "ask_user_async"
              ? snapshot
              : { requests: [snapshot] };
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
      const harness = createToolPresentationHarness(tool, { theme, width: 160 });
      const isBlocking = tool.name === "ask_user";
      harness.call(
        tool.name.endsWith("control") ? { action: "status", requestId: row.requestId } : questions,
        { expanded: true },
      );
      harness.result(
        {
          details: isBlocking
            ? selected
            : tool.name === "ask_user_async"
              ? row
              : { requests: [row] },
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

  it("describes failed answer delivery without showing agent procedures or identities", () => {
    const tool = register("compact").tools.find(
      (entry) => entry.name === "ask_user_async_control",
    )!;
    const harness = createToolPresentationHarness(tool, { theme, width: 200 });
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
      expect(!expanded && !/saved.*delivery failed/i.test(text)).toBe(false);
      expect(result).toEqual(before);
    }
  });

  it("retains raw malformed failures and cancellation guidance", () => {
    for (const tool of register("compact").tools) {
      const harness = createToolPresentationHarness(tool, { theme });
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
          details:
            tool.name === "ask_user"
              ? cancelled
              : tool.name === "ask_user_async"
                ? row
                : { requests: [row] },
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
});
