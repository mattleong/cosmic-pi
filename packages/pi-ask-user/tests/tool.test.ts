import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { captureRegistrations, createToolPresentationHarness } from "pi-code-previews/testing";
import { describe, expect, it, vi } from "vitest";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import { fallbackText } from "../src/ui/tool-render-projection.ts";
import { firstText, hostileContent, malformedNoteAnswers } from "./support/questionnaire.ts";

const request: AskUserRequest = {
  questions: [
    {
      key: "approach",
      title: "Approach",
      prompt: "Which approach?",
      mode: "single",
      choices: [
        { value: "safe", label: "Safe", description: "Minimize risk." },
        { value: "fast", label: "Fast", description: "Optimize delivery." },
      ],
    },
  ],
};

const captureTool = (
  ask: (request: AskUserRequest, signal: AbortSignal | undefined) => Promise<AskUserOutcome>,
) => captureRegistrations((pi) => registerAskUserTool(pi, ask)).tools[0]!;
type AskUserTool = ReturnType<typeof captureTool>;

const settled = { executionStarted: true, isPartial: false };
type CallArgs = Parameters<ReturnType<typeof createToolPresentationHarness>["call"]>[0];
const callOutput = (tool: AskUserTool, args: CallArgs) => {
  const harness = createToolPresentationHarness(tool, { width: 240 });
  harness.call(args, settled);
  return harness.render().join("\n");
};
const resultOutput = <Details>(
  tool: AskUserTool,
  details: Details,
  content: AgentToolResult<Details>["content"],
) => {
  const harness = createToolPresentationHarness(tool, { width: 240 });
  harness.call(request, settled);
  harness.result({ details, content }, settled);
  return harness.render().join("\n");
};

describe("ask_user tool", () => {
  it("returns first-class text with notes and replays text alongside historical answer tags", () => {
    const input: AskUserRequest = {
      questions: [{ key: "details", title: "Details", prompt: "Describe?", mode: "text" }],
    };
    const outcome: AskUserOutcome = {
      outcome: "submitted",
      answers: [{ key: "details", kind: "text", text: "bq1234\nanswer", note: "context" }],
    };
    const tool = captureTool(() => Promise.resolve(outcome));
    return tool
      .execute("text-call", input, undefined, undefined, extensionContextFixture())
      .then((result) => {
        expect(result.details).toEqual(outcome);
        expect(firstText(result.content)).toContain("bq1234\nanswer");
        const rendered = resultOutput(
          tool,
          {
            outcome: "submitted",
            answers: [
              outcome.answers[0],
              { key: "old", kind: "custom", text: "Historical custom" },
              { key: "choice", kind: "choices", labels: ["Historical choice"] },
            ],
          },
          [],
        );
        expect(rendered).toContain("bq1234");
        expect(rendered).toContain("answer");
        expect(rendered).toContain("Historical custom");
        expect(rendered).toContain("Historical choice");
        return undefined;
      });
  });
  it("shows notes under their answer, declines malformed notes, and rejects string content", () => {
    const tool = captureTool(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
    for (const malformed of malformedNoteAnswers())
      expect(
        resultOutput(tool, { outcome: "submitted", answers: [malformed] }, [
          { type: "text", text: "raw fallback" },
        ]),
      ).toContain("raw fallback");
    expect(fallbackText("string fallback")).toBe("");
  });

  it("executes the callback and renders valid submitted, custom, cancelled, and emoji data", () => {
    const outcome: AskUserOutcome = {
      outcome: "submitted",
      answers: [{ key: "approach", kind: "choices", values: ["safe"], labels: ["Safe"] }],
    };
    const ask = vi.fn(() => Promise.resolve(outcome));
    const tool = captureTool(ask);
    const signal = new AbortController().signal;
    const title = "😀".repeat(16);
    const call = callOutput(tool, { questions: [{ ...request.questions[0], title }] });
    const submitted = resultOutput(
      tool,
      {
        outcome: "submitted",
        answers: [
          { key: "choice", kind: "choices", labels: ["Safe"], values: ["safe"] },
          { key: "other", kind: "custom", text: "A custom answer" },
        ],
      },
      [],
    );

    expect(call).toContain(title);
    expect(submitted).toContain("choice");
    expect(submitted).toContain("Safe");
    expect(submitted).toContain("other");
    expect(submitted).toContain("A custom answer");
    expect(resultOutput(tool, { outcome: "cancelled", answers: [] }, [])).toMatch(/cancelled/i);
    return tool
      .execute("call", request, signal, undefined, extensionContextFixture())
      .then((result) => {
        expect(ask).toHaveBeenCalledWith(request, signal);
        expect(result.details).toEqual(outcome);
        expect(firstText(result.content)).toContain("safe (Safe)");
        return undefined;
      });
  });

  it("renders six questions and answers but uses neutral or sanitized text fallbacks beyond them", () => {
    const tool = captureTool(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
    const questions = Array.from({ length: 7 }, (_, index) => ({ title: `private-${index + 1}` }));
    const answers = Array.from({ length: 7 }, (_, index) => ({
      key: `key-${index}`,
      kind: "custom",
      text: `value-${index + 1}`,
    }));
    const labels = ["one", "two", "three", "four", "five"];

    expect(callOutput(tool, { questions: questions.slice(0, 6) })).toContain("private-6");
    expect(
      resultOutput(tool, { outcome: "submitted", answers: answers.slice(0, 6) }, []),
    ).toContain("value-6");
    expect(() => callOutput(tool, { questions: "invalid" })).not.toThrow();
    expect(callOutput(tool, { questions })).not.toContain("private-1");
    const fallback = resultOutput(tool, { outcome: "submitted", answers }, [
      { type: "text", text: "answer\u001b[31m fallback" },
      { type: "image", data: "secret", mimeType: "image/png" },
      { type: "text", text: "after" },
    ]);
    expect(fallback).toContain("answer fallback");
    expect(fallback).toContain("after");
    expect(fallback).not.toContain("secret");
    expect(fallback).not.toContain("\u001b");
    expect(fallbackText(hostileContent("answer"))).toBe("answer fallback\nafter");
    expect(
      resultOutput(
        tool,
        { outcome: "submitted", answers: [{ key: "choice", kind: "choices", labels }] },
        [{ type: "text", text: "label fallback" }],
      ),
    ).toContain("label fallback");
  });
});
