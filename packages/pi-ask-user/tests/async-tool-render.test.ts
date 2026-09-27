import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { plainTheme as theme } from "pi-cosmic-core/testing";
import {
  renderAsyncCall,
  renderAsyncContent,
  renderAsyncMessage,
  renderAsyncResult,
} from "../src/ui/async-tool-render.ts";

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
// The agent-facing text names the request; the transcript shows it only under its label.
const agentText = `Request ${snapshot.requestId} · delivery ${snapshot.deliveryId}\nComplete agent guidance remains available.`;
const message = {
  details: { ...snapshot, generation: "generation-private-id" },
  content: agentText,
};
const result = <Details, Content>(details: Details, expanded = false, content?: Content) =>
  output(renderAsyncResult({ details, content }, { expanded, isPartial: false }, theme));

describe("async questionnaire replay rendering", () => {
  it("compact notifications keep the delivered text, answers, and unknown content behind expansion", () => {
    const withoutText = { details: message.details, content: "" };
    for (const input of [message, withoutText, { content: "Full fallback diagnostic" }]) {
      for (const expanded of [false, true, false]) {
        const text = output(renderAsyncMessage(input, { expanded, outputPad: 0 }, theme, true));
        expect(text).not.toContain("generation-private-id");
        if (input === message) {
          expect(text.includes("Complete agent guidance")).toBe(expanded);
          expect(text).not.toContain("Scenic");
        } else if (input === withoutText) {
          // A replay without text shows its answers and notes whole.
          expect(text.includes("Scenic")).toBe(expanded);
          expect(text.includes("Avoid tolls")).toBe(expanded);
        } else {
          expect(text.includes("Full fallback diagnostic")).toBe(expanded);
          // The expansion hint belongs only to the collapsed row.
          expect(text.includes("details on expand")).toBe(!expanded);
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

  it("previews answers with notes beneath them and keeps IDs in the labeled raw text", () => {
    for (const rendered of [
      result(snapshot, false, agentText),
      result({ requests: [snapshot] }, false, agentText),
      output(renderAsyncMessage(message, { expanded: false, outputPad: 0 }, theme)),
    ]) {
      const lines = rendered.split("\n");
      for (const value of ["Scenic", "Tomorrow morning", "Text answer"])
        expect(rendered).toContain(value);
      // Notes sit indented beneath their own answer.
      const scenic = lines.findIndex((line) => line.includes("Scenic"));
      expect(lines[scenic + 1]).toMatch(/^\s+.*Avoid tolls/);
      const text = lines.findIndex((line) => line.includes("Text answer"));
      expect(lines.slice(text + 1).join("\n")).toMatch(/^\s+.*Text context/m);
      // Multi-line text keeps one line and an expansion hint until expanded.
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

  it("expands legacy IDs and work fields without accepting malformed work", () => {
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
          renderAsyncContent(
            { details, content: "Continue only this independent work: Inspect first" },
            { expanded: true, isPartial: false },
            theme,
          ),
        );
        expect(content).toContain("Inspect first");
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
    const expanded = output(
      renderAsyncContent(
        { details: invalid, content: "raw fallback" },
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

  it("renders six questions and answers but falls back safely beyond them and for hostile data", () => {
    const hostile = Object.defineProperty({}, "details", {
      get() {
        throw new Error("hostile getter");
      },
    });
    const questions = Array.from({ length: 6 }, (_, index) => ({ title: `Question ${index + 1}` }));
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
    const throwingPart = Object.defineProperty({ type: "text" }, "text", {
      get() {
        throw new Error("hostile text");
      },
    });
    const content = [
      { type: "text", text: "safe\u001b[31m fallback" },
      { type: "image", data: "secret" },
      { type: "text", text: 123 },
      null,
      throwingPart,
      { type: "text", text: "after" },
    ];
    const hostileId = Object.defineProperty({ ...snapshot }, "requestId", {
      get() {
        throw new Error("hostile ID getter");
      },
    });
    for (const rendered of [
      ...[...invalid, hostileId, { requests: [hostileId] }].map((details) =>
        result(details, false, content),
      ),
      output(renderAsyncMessage({ content }, { expanded: false, outputPad: 0 }, theme)),
    ]) {
      expect(rendered).toContain("safe fallback");
      expect(rendered).toContain("after");
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
        callContext(true),
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
      output(renderAsyncCall({ questions: [{ title: dirty }] }, theme, callContext())),
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
        { details: { requests: [{ ...pending, presentation: "open" }, snapshot] } },
        { expanded: false, isPartial: false },
        theme,
        { args: { action: "status" } },
      ),
    );
    expect(listed).toMatch(/1 waiting/);
    expect(listed).toMatch(/1 answered/);
    expect(result({ requests: [] })).not.toBe("");
    // A returned cancellation is stated once, as cancelled; failures are the shell's issue lines.
    const cancelledResult = { ...snapshot, status: "cancelled", outcome: { outcome: "cancelled" } };
    expect(result(cancelledResult, false, agentText)).toMatch(/⊘ Cancelled/);
    expect(result(cancelledResult, false, agentText)).not.toContain("⚠");
    const failed = { ...snapshot, status: "failed", outcome: undefined };
    expect(result(failed, false, agentText).trim()).toBe("");
    for (const details of [snapshot, cancelledResult])
      expect(
        output(
          renderAsyncResult({ details }, { expanded: false, isPartial: false }, theme, {
            isError: true,
          }),
        ).trim(),
      ).toBe("");
  });

  it("marks cancelled messages as cancelled, never as a warning", () => {
    const cancelledMessage = {
      details: { ...message.details, outcome: { outcome: "cancelled" } },
      content: "The user cancelled the questionnaire.",
    };
    for (const compact of [false, true])
      for (const expanded of [false, true]) {
        const text = output(
          renderAsyncMessage(cancelledMessage, { expanded, outputPad: 0 }, theme, compact),
        );
        expect(text).toContain("⊘");
        expect(text).not.toContain("⚠");
      }
  });

  it("headers name the tool and subject without request IDs", () => {
    for (const expanded of [false, true]) {
      for (const action of ["status", "await", "cancel"]) {
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
