import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import { AskUserParameters, type AskUserRequest } from "../src/questionnaire/schema.ts";
import { registerAskUserTool } from "../src/tools/ask-user.ts";

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

const opaqueHostFixture = <Value>(value: Value): never => {
  // SAFETY: Tests supply every opaque Pi host member exercised by the subject.
  return value as never;
};

const theme: Theme = opaqueHostFixture({
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
});
const renderContext = () =>
  opaqueHostFixture({
    args: {},
    toolCallId: "call",
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  });

type AskUserTool = ToolDefinition<typeof AskUserParameters, AskUserOutcome>;
type CapturedTool = Pick<AskUserTool, "execute"> & {
  readonly renderCall: NonNullable<AskUserTool["renderCall"]>;
  readonly renderResult: NonNullable<AskUserTool["renderResult"]>;
};

const captureTool = (
  ask: (request: AskUserRequest, signal: AbortSignal | undefined) => Promise<AskUserOutcome>,
): CapturedTool => {
  const tools: AskUserTool[] = [];
  registerAskUserTool(
    opaqueHostFixture({ registerTool: (tool: AskUserTool) => tools.push(tool) }),
    ask,
  );
  const tool = tools[0];
  if (!tool?.renderCall || !tool.renderResult) throw new Error("ask_user was not registered.");
  return { execute: tool.execute, renderCall: tool.renderCall, renderResult: tool.renderResult };
};

const output = (component: Component): string => component.render(240).join("\n");
const resultOutput = <Details, Content>(tool: CapturedTool, details: Details, content: Content) =>
  output(
    tool.renderResult(
      opaqueHostFixture({ details, content }),
      { expanded: false, isPartial: false },
      theme,
      renderContext(),
    ),
  );

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
      .execute("text-call", input, undefined, undefined, opaqueHostFixture({}))
      .then((result) => {
        expect(result.details).toEqual(outcome);
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining("bq1234\nanswer"),
        });
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
      });
  });
  it("ignores notes without reading them and rejects string fallback content", () => {
    const tool = captureTool(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
    const hostileNote = Object.defineProperty({}, "note", {
      get() {
        throw new Error("hostile note");
      },
    });
    for (const note of [{ note: 123 }, { note: "hidden note" }, hostileNote]) {
      const answer = Object.defineProperties(
        { key: "route", kind: "custom", text: "Scenic" },
        Object.getOwnPropertyDescriptors(note),
      );
      const rendered = resultOutput(tool, { outcome: "submitted", answers: [answer] }, []);
      expect(rendered).toContain("Scenic");
      expect(rendered).not.toContain("hidden note");
    }
    expect(resultOutput(tool, null, "string fallback")).not.toContain("string fallback");
  });

  it("isolates throwing content parts from valid siblings", () => {
    const tool = captureTool(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
    const hostile = Object.defineProperty({ type: "text" }, "text", {
      get() {
        throw new Error("hostile text");
      },
    });
    const rendered = resultOutput(tool, null, [
      { type: "text", text: "before" },
      hostile,
      { type: "text", text: "after" },
    ]);
    expect(rendered).toContain("before");
    expect(rendered).toContain("after");
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
    const call = output(
      tool.renderCall(
        opaqueHostFixture({ questions: [{ ...request.questions[0], title }] }),
        theme,
        renderContext(),
      ),
    );
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
    expect(resultOutput(tool, { outcome: "cancelled", answers: [] }, [])).toContain("cancelled");
    return tool
      .execute("call", request, signal, undefined, opaqueHostFixture({}))
      .then((result) => {
        expect(ask).toHaveBeenCalledWith(request, signal);
        expect(result.details).toEqual(outcome);
        expect(result.content[0]).toMatchObject({ text: expect.stringContaining("safe (Safe)") });
      });
  });

  it("ignores malformed parts and sanitizes fallback text", () => {
    const tool = captureTool(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
    const rendered = resultOutput(
      tool,
      { outcome: "submitted", answers: [{ key: "missing-text", kind: "custom" }] },
      [
        { type: "text", text: "safe \u001b[31mred\u001b[0m" },
        { type: "text", text: 123 },
        { type: "image", data: "private" },
        null,
        { type: "text", text: "second" },
      ],
    );

    expect(rendered).toContain("safe red");
    expect(rendered).toContain("second");
    expect(rendered).not.toContain("123");
    expect(rendered).not.toContain("private");
    expect(rendered).not.toContain("\u001b");
  });

  it("renders all six questions and submitted answers", () => {
    const tool = captureTool(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
    const questions = Array.from({ length: 6 }, (_, index) => ({ title: `Question ${index + 1}` }));
    const answers = Array.from({ length: 6 }, (_, index) => ({
      key: `answer-${index + 1}`,
      kind: "custom",
      text: `value-${index + 1}`,
    }));
    expect(
      output(tool.renderCall(opaqueHostFixture({ questions }), theme, renderContext())),
    ).toContain("Question 6");
    expect(resultOutput(tool, { outcome: "submitted", answers }, [])).toContain("value-6");
  });

  it("uses neutral or text fallbacks for malformed and oversized arrays", () => {
    const tool = captureTool(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
    const call = (questions: ReadonlyArray<{ readonly title: string }>) =>
      output(tool.renderCall(opaqueHostFixture({ questions }), theme, renderContext()));
    const answers = Array.from({ length: 7 }, (_, index) => ({
      key: `key-${index}`,
      kind: "custom",
      text: "value",
    }));
    const labels = ["one", "two", "three", "four", "five"];
    const oversized = call(
      Array.from({ length: 7 }, (_, index) => ({ title: `private-${index}` })),
    );

    expect(() =>
      output(tool.renderCall(opaqueHostFixture({ questions: "invalid" }), theme, renderContext())),
    ).not.toThrow();
    expect(oversized).not.toContain("private-0");
    expect(
      resultOutput(tool, { outcome: "submitted", answers }, [
        { type: "text", text: "answer fallback" },
      ]),
    ).toContain("answer fallback");
    expect(
      resultOutput(
        tool,
        { outcome: "submitted", answers: [{ key: "choice", kind: "choices", labels }] },
        [{ type: "text", text: "label fallback" }],
      ),
    ).toContain("label fallback");
  });
});
