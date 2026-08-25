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
    expect(submitted).toContain("choice: Safe");
    expect(submitted).toContain("other: A custom answer");
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

  it("uses neutral or text fallbacks for malformed and oversized arrays", () => {
    const tool = captureTool(() => Promise.resolve({ outcome: "cancelled", answers: [] }));
    const call = (questions: ReadonlyArray<{ readonly title: string }>) =>
      output(tool.renderCall(opaqueHostFixture({ questions }), theme, renderContext()));
    const answers = Array.from({ length: 5 }, (_, index) => ({
      key: `key-${index}`,
      kind: "custom",
      text: "value",
    }));
    const labels = ["one", "two", "three", "four", "five"];
    const oversized = call(
      Array.from({ length: 5 }, (_, index) => ({ title: `private-${index}` })),
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
