import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  renderAsyncCall,
  renderAsyncContent,
  renderAsyncMessage,
  renderAsyncResult,
} from "../src/ui/async-tool-render.ts";

// SAFETY: The fixture supplies every theme operation used by these renderers.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const output = (component: Component) => component.render(240).join("\n");
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
const message = {
  details: { ...snapshot, generation: "generation-private-id" },
  content: "Complete agent guidance remains available.",
};
const result = <Details, Content>(details: Details, expanded = false, content?: Content) =>
  output(renderAsyncResult({ details, content }, { expanded, isPartial: false }, theme));

describe("async questionnaire replay rendering", () => {
  it("compact notifications keep answers and unknown content behind expansion", () => {
    for (const input of [message, { content: "Full fallback diagnostic" }]) {
      for (const expanded of [false, true, false]) {
        const text = output(renderAsyncMessage(input, { expanded, outputPad: 0 }, theme, true));
        if (input === message) {
          expect(text.includes("Scenic")).toBe(expanded);
          expect(text.includes("Avoid tolls")).toBe(expanded);
        } else {
          expect(text.includes("Full fallback diagnostic")).toBe(expanded);
        }
      }
    }
  });

  it("rejects malformed or hostile notes but accepts string fallback content", () => {
    const hostileNote = Object.defineProperty({}, "note", {
      get() {
        throw new Error("hostile note");
      },
    });
    for (const note of [{ note: 123 }, hostileNote]) {
      const answer = Object.defineProperties(
        { key: "route", kind: "custom", text: "Scenic" },
        Object.getOwnPropertyDescriptors(note),
      );
      const details = { ...snapshot, outcome: { outcome: "submitted", answers: [answer] } };
      for (const rendered of [
        result(details, false, "string fallback"),
        output(
          renderAsyncMessage(
            { details: { ...details, generation: "generation" }, content: "string fallback" },
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

  it("isolates throwing content parts from valid siblings", () => {
    const hostile = Object.defineProperty({ type: "text" }, "text", {
      get() {
        throw new Error("hostile text");
      },
    });
    const content = [{ type: "text", text: "before" }, hostile, { type: "text", text: "after" }];
    for (const rendered of [
      result(null, false, content),
      output(renderAsyncMessage({ content }, { expanded: false, outputPad: 0 }, theme)),
    ]) {
      expect(rendered).toContain("before");
      expect(rendered).toContain("after");
    }
  });

  it("projects answers and notes without exposing delivery metadata until expanded", () => {
    for (const rendered of [
      result(snapshot),
      result({ requests: [snapshot] }),
      output(renderAsyncMessage(message, { expanded: false, outputPad: 0 }, theme)),
    ]) {
      expect(rendered).toContain("Scenic");
      expect(rendered).toContain("Tomorrow morning");
      expect(rendered).toContain("Avoid tolls");
      expect(rendered).toContain("Text answer");
      expect(rendered).toContain("with another line");
      expect(rendered).toContain("Text context");
      expect(rendered).not.toContain(snapshot.requestId);
      expect(rendered).not.toContain(snapshot.deliveryId);
    }
    for (const rendered of [
      result(snapshot, true, message.content),
      output(renderAsyncMessage(message, { expanded: true, outputPad: 0 }, theme)),
    ]) {
      expect(rendered).toContain(snapshot.requestId);
      expect(rendered).toContain(snapshot.deliveryId);
      expect(rendered).toContain(message.content);
    }
  });

  it("retains expanded legacy IDs and work fields without accepting malformed work", () => {
    for (const id of ["", "x".repeat(257)]) {
      const legacy = {
        ...snapshot,
        requestId: id,
        deliveryId: id,
        independentWork: "Inspect first",
        blockedWork: "Wait for decision",
      };
      for (const details of [legacy, { requests: [legacy] }]) {
        expect(result(details, true)).toContain("Avoid tolls");
        const content = output(
          renderAsyncContent({ details }, { expanded: true, isPartial: false }, theme),
        );
        expect(content).toContain("Independent work: Inspect first");
        expect(content).toContain("Wait for answers before: Wait for decision");
      }
      expect(
        output(
          renderAsyncMessage(
            { details: { requestId: id, deliveryId: id, generation: "", outcome } },
            { expanded: true, outputPad: 0 },
            theme,
          ),
        ),
      ).toContain("Avoid tolls");
    }
    const invalid = { ...snapshot, independentWork: 123 };
    expect(result(invalid, false, "raw fallback").trimEnd()).toBe("raw fallback");
    expect(
      output(
        renderAsyncContent(
          { details: invalid, content: "raw fallback" },
          { expanded: true, isPartial: false },
          theme,
        ),
      ).trimEnd(),
    ).toBe("raw fallback");
  });

  it("renders six-question calls and all six submitted answers", () => {
    const questions = Array.from({ length: 6 }, (_, index) => ({ title: `Question ${index + 1}` }));
    const answers = Array.from({ length: 6 }, (_, index) => ({
      key: `answer-${index + 1}`,
      kind: "custom",
      text: `value-${index + 1}`,
    }));
    expect(output(renderAsyncCall({ questions }, theme, false))).toContain("Question 6");
    expect(result({ ...snapshot, outcome: { outcome: "submitted", answers } })).toContain(
      "value-6",
    );
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
      output(renderAsyncResult({ details: snapshot }, { expanded: false, isPartial: true }, theme)),
    ).not.toContain("Scenic");
    expect(
      output(
        renderAsyncMessage(
          {
            ...message,
            details: {
              ...message.details,
              outcome: { outcome: "cancelled", answers: outcome.answers },
            },
          },
          { expanded: false, outputPad: 0 },
          theme,
        ),
      ),
    ).not.toContain("Scenic");
  });

  it("falls back safely for malformed, oversized, and hostile replay data", () => {
    const hostile = Object.defineProperty({}, "details", {
      get() {
        throw new Error("hostile getter");
      },
    });
    const invalid = [
      null,
      { ...snapshot, outcome: { outcome: "submitted", answers: [{ kind: "custom" }] } },
      { requests: Array.from({ length: 17 }, () => snapshot) },
      {
        ...snapshot,
        outcome: {
          outcome: "submitted",
          answers: Array.from({ length: 7 }, () => outcome.answers[0]),
        },
      },
    ];
    const content = [
      { type: "text", text: "safe\u001b[31m fallback" },
      { type: "image", data: "secret" },
      { type: "text", text: 123 },
      null,
    ];
    const hostileId = Object.defineProperty({ ...snapshot }, "requestId", {
      get() {
        throw new Error("hostile ID getter");
      },
    });
    for (const details of [...invalid, hostileId, { requests: [hostileId] }]) {
      const rendered = result(details, false, content);
      expect(rendered).toContain("safe fallback");
      expect(rendered).not.toContain("secret");
      expect(rendered).not.toContain("\u001b");
    }
    expect(() =>
      renderAsyncResult(hostile, { expanded: true, isPartial: false }, theme),
    ).not.toThrow();
    expect(() =>
      renderAsyncMessage(hostile, { expanded: true, outputPad: 0 }, theme),
    ).not.toThrow();
    expect(() =>
      renderAsyncCall(
        Object.defineProperty({}, "questions", {
          get() {
            throw new Error("hostile getter");
          },
        }),
        theme,
        false,
      ),
    ).not.toThrow();
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
      output(renderAsyncMessage({ content: dirty }, { expanded: false, outputPad: 0 }, theme)),
      output(renderAsyncCall({ questions: [{ title: dirty }] }, theme, false)),
    ];
    for (const text of rendered) {
      expect(text).toContain("value");
      expect(text).not.toContain("\u001b");
    }
  });
});
