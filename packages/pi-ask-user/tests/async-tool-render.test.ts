import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { plainTheme as theme } from "pi-cosmic-core/testing";
import { ASYNC_MESSAGE_TYPE } from "../src/boundary/host-delivery.ts";
import type { AskUserQuestion } from "../src/questionnaire/schema.ts";
import {
  renderAsyncCall,
  renderAsyncContent,
  renderAsyncMessage,
  renderAsyncResult,
} from "../src/ui/async-tool-render.ts";
import type { QuestionnaireArgs } from "../src/ui/tool-body.ts";
import { contentText } from "../src/ui/tool-render-projection.ts";
import { hostile, hostileContent, malformedNoteAnswers } from "./support/questionnaire.ts";

type ResultDetails = Parameters<typeof renderAsyncResult>[0]["details"];
type MessageInput = Parameters<typeof renderAsyncMessage>[0];

const output = (component: Component) => component.render(240).join("\n");
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
const agentText = `Request ${snapshot.requestId} · delivery ${snapshot.deliveryId}\nComplete agent guidance remains available.`;
const textContent = (text: string) => (text === "" ? [] : [{ type: "text" as const, text }]);
const asyncMessage = (content: MessageInput["content"], details?: ResultDetails): MessageInput => ({
  role: "custom",
  customType: ASYNC_MESSAGE_TYPE,
  content,
  display: true,
  timestamp: 0,
  details,
});
const message = asyncMessage(agentText, { ...snapshot, generation: "generation-private-id" });
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
  it("compact notifications keep the delivered text, answers, and unknown content behind expansion", () => {
    const withoutText = asyncMessage("", message.details);
    for (const input of [message, withoutText, asyncMessage("Full fallback diagnostic")]) {
      for (const expanded of [false, true, false]) {
        const text = output(renderAsyncMessage(input, { expanded, outputPad: 0 }, theme, true));
        expect(text).not.toContain("generation-private-id");
        if (input === message) {
          expect(text.includes("Complete agent guidance")).toBe(expanded);
          expect(text).not.toContain("Scenic");
        } else if (input === withoutText) {
          expect(text.includes("Scenic")).toBe(expanded);
          expect(text.includes("Avoid tolls")).toBe(expanded);
        } else {
          expect(text.includes("Full fallback diagnostic")).toBe(expanded);
        }
      }
    }
  });

  it("rejects malformed or hostile notes but accepts string fallback content", () => {
    for (const answer of malformedNoteAnswers()) {
      const details = { ...snapshot, outcome: { outcome: "submitted", answers: [answer] } };
      for (const rendered of [
        result(details, false, "string fallback"),
        output(
          renderAsyncMessage(
            asyncMessage("string fallback", { ...details, generation: "generation" }),
            { expanded: false, outputPad: 0 },
            theme,
          ),
        ),
      ]) {
        expect(rendered).toContain("string fallback");
        expect(rendered).not.toContain("Scenic");
      }
    }
  });

  it("previews answers with notes beneath them and keeps IDs in the labeled raw text", () => {
    for (const rendered of [
      result(snapshot, false, agentText),
      result({ requests: [snapshot] }, false, agentText),
      output(renderAsyncMessage(message, { expanded: false, outputPad: 0 }, theme)),
    ]) {
      const lines = rendered.split("\n");
      for (const value of ["Scenic", "Tomorrow morning", "Text answer"])
        expect(rendered).toContain(value);
      const scenic = lines.findIndex((line) => line.includes("Scenic"));
      expect(lines[scenic + 1]).toMatch(/.*Avoid tolls/);
      const text = lines.findIndex((line) => line.includes("Text answer"));
      expect(lines.slice(text + 1).join("\n")).toMatch(/.*Text context/m);
      expect(rendered).not.toContain("with another line");
      expect(rendered).toMatch(/expand/);
      expect(rendered).not.toContain(snapshot.requestId);
      expect(rendered).not.toContain(snapshot.deliveryId);
    }
    for (const rendered of [
      result(snapshot, true, agentText),
      output(renderAsyncMessage(message, { expanded: true, outputPad: 0 }, theme)),
    ]) {
      const lines = rendered.split("\n");
      const label = lines.findIndex((line) => line.trim() === "Raw result");
      expect(label).toBeGreaterThanOrEqual(0);
      expect(lines.slice(0, label).join("\n")).not.toContain(snapshot.requestId);
      expect(lines.slice(label).join("\n")).toContain(snapshot.requestId);
      expect(lines.slice(label).join("\n")).toContain(snapshot.deliveryId);
      expect(rendered).not.toContain("generation-private-id");
    }
    const unlabeled = { ...snapshot, outcome: { ...outcome, answers: [outcome.answers[2]!] } };
    expect(result(unlabeled, true)).toContain("with another line");
  });

  it("expands out-of-contract IDs and work fields without accepting malformed work", () => {
    for (const id of ["", "x".repeat(257)]) {
      const nonconforming = {
        ...snapshot,
        requestId: id,
        deliveryId: id,
        independentWork: "Inspect first",
        blockedWork: "Wait for decision",
      };
      for (const details of [nonconforming, { requests: [nonconforming] }]) {
        expect(result(details, true)).toContain("Avoid tolls");
        const content = output(
          renderAsyncContent(
            { details, content: textContent("Continue only this independent work: Inspect first") },
            { expanded: true, isPartial: false },
            theme,
          ),
        );
        expect(content).toContain("Inspect first");
      }
      expect(
        output(
          renderAsyncMessage(
            asyncMessage("", { requestId: id, deliveryId: id, generation: "", outcome }),
            { expanded: true, outputPad: 0 },
            theme,
          ),
        ),
      ).toContain("Avoid tolls");
    }
    const invalid = { ...snapshot, independentWork: 123 };
    expect(result(invalid, false, "raw fallback").trimEnd()).toBe("raw fallback");
    const expanded = output(
      renderAsyncContent(
        { details: invalid, content: textContent("raw fallback") },
        { expanded: true, isPartial: false },
        theme,
      ),
    );
    expect(expanded).toContain("raw fallback");
    expect(expanded).not.toContain("Avoid tolls");
  });

  it("prefers a valid single snapshot over an invalid list", () => {
    const details = { ...snapshot, requests: [{ ...snapshot, delivery: 123 }] };
    expect(result(details)).toContain("Avoid tolls");
    expect(
      result(
        { requests: [snapshot, { ...snapshot, delivery: 123 }] },
        false,
        "raw fallback",
      ).trimEnd(),
    ).toBe("raw fallback");
  });

  it("does not show stale submitted answers for pending, failed, cancelled, or partial results", () => {
    for (const status of ["pending", "failed", "cancelled"]) {
      expect(result({ ...snapshot, status })).not.toContain("Scenic");
    }
    expect(
      output(
        renderAsyncResult(
          { details: snapshot, content: [] },
          { expanded: false, isPartial: true },
          theme,
        ),
      ),
    ).not.toContain("Scenic");
    expect(
      output(
        renderAsyncMessage(
          asyncMessage(agentText, {
            ...snapshot,
            generation: "generation-private-id",
            outcome: { outcome: "cancelled", answers: outcome.answers },
          }),
          { expanded: false, outputPad: 0 },
          theme,
        ),
      ),
    ).not.toContain("Scenic");
  });

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
      ...[...invalid, hostileId, { requests: [hostileId] }].map((details) =>
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

  it("shows routine state and counts collapsed, and leaves failures to the shell", () => {
    const pending = { ...snapshot, status: "pending", delivery: "pending", outcome: undefined };
    const waiting = result({ ...pending, presentation: "open" });
    const queued = result({ ...pending, presentation: "queued" });
    expect(waiting).toMatch(/waiting/i);
    expect(queued).toMatch(/queued/i);
    expect(queued).not.toMatch(/waiting/i);
    const listed = output(
      renderAsyncResult(
        { details: { requests: [{ ...pending, presentation: "open" }, snapshot] }, content: [] },
        { expanded: false, isPartial: false },
        theme,
        { args: { action: "status" } },
      ),
    );
    expect(listed).toMatch(/1 waiting/);
    expect(listed).toMatch(/1 answered/);
    expect(result({ requests: [] })).not.toBe("");
    const cancelledResult = { ...snapshot, status: "cancelled", outcome: { outcome: "cancelled" } };
    expect(result(cancelledResult, false, agentText)).toMatch(/cancelled/i);
    const failed = { ...snapshot, status: "failed", outcome: undefined };
    expect(result(failed, false, agentText).trim()).toBe("");
    for (const details of [snapshot, cancelledResult])
      expect(
        output(
          renderAsyncResult(
            { details, content: [] },
            { expanded: false, isPartial: false },
            theme,
            {
              isError: true,
            },
          ),
        ).trim(),
      ).toBe("");
  });

  it("headers name the tool and subject without request IDs", () => {
    for (const expanded of [false, true]) {
      for (const action of ["status", "await", "cancel"] as const) {
        const heading = output(
          renderAsyncCall(
            { action, requestId: "request-private-id" },
            theme,
            callContext(expanded),
            true,
          ),
        ).split("\n")[0];
        expect(heading).toContain(action);
        expect(heading).not.toContain("request-private-id");
      }
    }
  });
});
