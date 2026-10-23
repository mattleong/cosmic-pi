import type { Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { plainTheme as theme } from "pi-cosmic-core/testing";
import { ASYNC_MESSAGE_TYPE } from "../src/boundary/host-delivery.ts";
import type { AskUserQuestion } from "../src/questionnaire/schema.ts";
import {
  renderAsyncCall,
  renderAsyncMessage,
  renderAsyncResult,
} from "../src/ui/async-tool-render.ts";
import type { QuestionnaireArgs } from "../src/ui/tool-body.ts";
import { contentText } from "../src/ui/tool-render-projection.ts";
import { hostile, hostileContent } from "./support/questionnaire.ts";

type ResultDetails = Parameters<typeof renderAsyncResult>[0]["details"];
type MessageInput = Parameters<typeof renderAsyncMessage>[0];

const output = (component: Component) => Arr.join(component.render(240), "\n");
const callContext = (expanded = false) => ({ expanded, state: {} });
const outcome = {
  outcome: "submitted",
  answers: [
    { key: "route", kind: "choices", labels: ["Scenic"], note: "Avoid tolls" },
    { key: "time", kind: "custom", text: "Tomorrow morning" },
    { key: "details", kind: "text", text: "Text answer\nwith another line", note: "Text context" },
  ],
};
const snapshot = {
  requestId: "request-private-id",
  deliveryId: "delivery-private-id",
  status: "submitted",
  delivery: "sent",
  outcome,
};
const textContent = (text: string) => (text === "" ? [] : [{ type: "text" as const, text }]);
const asyncMessage = (content: MessageInput["content"], details?: ResultDetails): MessageInput => ({
  role: "custom",
  customType: ASYNC_MESSAGE_TYPE,
  content,
  display: true,
  timestamp: 0,
  details,
});
const result = (details: ResultDetails, expanded = false, content = "") =>
  output(
    renderAsyncResult(
      { details, content: textContent(content) },
      { expanded, isPartial: false },
      theme,
    ),
  );
const question = (title: string): AskUserQuestion => ({
  key: title,
  title,
  prompt: "Prompt?",
  mode: "text",
});

describe("async questionnaire replay rendering", () => {
  it("renders six questions and answers but falls back safely beyond them and for hostile data", () => {
    const hostileResult = hostile({ details: undefined, content: [] }, "details");
    const hostileMessage = hostile(asyncMessage(""), "details");
    const hostileArgs: QuestionnaireArgs = hostile({}, "questions");
    const questions = Array.from({ length: 6 }, (_, index) => question(`Question ${index + 1}`));
    const answers = Array.from({ length: 7 }, (_, index) => ({
      key: `answer-${index + 1}`,
      kind: "custom",
      text: `value-${index + 1}`,
    }));
    expect(output(renderAsyncCall({ questions }, theme, callContext()))).toContain("Question 6");
    expect(
      result({ ...snapshot, outcome: { outcome: "submitted", answers: answers.slice(0, 6) } }),
    ).toContain("value-6");
    const invalid = [
      null,
      { ...snapshot, outcome: { outcome: "submitted", answers: [{ kind: "custom" }] } },
      { requests: Array.from({ length: 17 }, () => snapshot) },
      { ...snapshot, outcome: { outcome: "submitted", answers } },
    ];
    const content = [
      { type: "text" as const, text: "safe\u001b[31m fallback" },
      { type: "image" as const, data: "secret", mimeType: "image/png" },
      { type: "text" as const, text: "after" },
    ];
    expect(contentText(hostileContent("safe"))).toBe("safe fallback\nafter");
    const hostileId = hostile({ ...snapshot }, "requestId");
    for (const rendered of [
      ...Arr.map([...invalid, hostileId, { requests: [hostileId] }], (details) =>
        output(
          renderAsyncResult({ details, content }, { expanded: false, isPartial: false }, theme),
        ),
      ),
      output(renderAsyncMessage(asyncMessage(content), { expanded: false, outputPad: 0 }, theme)),
    ]) {
      expect(rendered).toContain("safe fallback");
      expect(rendered).toContain("after");
      expect(rendered).not.toContain("secret");
      expect(rendered).not.toContain("\u001b");
    }
    expect(() =>
      renderAsyncResult(hostileResult, { expanded: true, isPartial: false }, theme),
    ).not.toThrow();
    expect(() =>
      renderAsyncMessage(hostileMessage, { expanded: true, outputPad: 0 }, theme),
    ).not.toThrow();
    expect(() => renderAsyncCall(hostileArgs, theme, callContext(true))).not.toThrow();
  });

  it("sanitizes answers, notes, titles, metadata and notification fallback text", () => {
    const dirty = "value\u001b[31m";
    const details = {
      ...snapshot,
      requestId: dirty,
      deliveryId: dirty,
      outcome: {
        outcome: "submitted",
        answers: [{ key: dirty, kind: "custom", text: dirty, note: dirty }],
      },
    };
    const rendered = [
      result(details, true),
      output(renderAsyncMessage(asyncMessage(dirty), { expanded: false, outputPad: 0 }, theme)),
      output(renderAsyncCall({ questions: [question(dirty)] }, theme, callContext())),
    ];
    for (const text of rendered) {
      expect(text).toContain("value");
      expect(text).not.toContain("\u001b");
    }
  });
});
