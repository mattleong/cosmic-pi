import { initTheme, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { stripAnsi } from "pi-cosmic-core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  expandedAuthoredText,
  expandedBody,
  expandedDetails,
  headingShowedSubject,
  withCodePreviewMessageShell,
  type CodePreviewMessagePresenter,
} from "../../index";
import { withPresentationSettings } from "../../testing";
import { publishSharedPresentation } from "../../src/config/state";
import { customMessage, drawMessage } from "../support/render";

const WORDS = Arr.map(Arr.range(1, 30), (line) => `line ${line} of what the agent wrote`);

const message = customMessage({ details: { words: WORDS } });

const lines = (rows: ReadonlyArray<string>): Component => new Text(Arr.join(rows, "\n"), 0, 0);

const present: CodePreviewMessagePresenter = () => ({
  name: "example",
  label: "Example",
  summary: { subject: "MESSAGE SUBJECT", outcome: "returned" },
  collapsed: () => lines([...WORDS.slice(0, 10), "more on expand"]),
  expanded: () => lines(WORDS),
  expandLabel: "message",
});

const draw = (render: MessageRenderer, expanded: boolean, input = message, width = 80): string =>
  stripAnsi(Arr.join(drawMessage(render, expanded, input, width), "\n"));

// The body repeats the subject unless the heading reports it drew the subject whole.
const subjectBody =
  (subject: string): CodePreviewMessagePresenter =>
  () => ({
    name: "example",
    summary: { subject, outcome: "success" },
    expanded: (headingState) => ({
      render: () => (headingShowedSubject(headingState) ? ["BODY"] : ["BODY", "SUBJECT AGAIN"]),
      invalidate: () => undefined,
    }),
  });

/** A delivered message: its words unlabeled, then the sender's IDs. */
const delivered =
  (sender: string): CodePreviewMessagePresenter =>
  (_message, _options, theme) => ({
    name: "session_message",
    summary: { subject: sender, outcome: "returned", messageIcon: "received" },
    expanded: () =>
      expandedBody(
        expandedAuthoredText(theme, undefined, "Please rerun the tests"),
        expandedDetails(theme, ["session-1"]),
      ),
  });

/** An agent's report: its words unlabeled, with an optional body label. */
const reported =
  (subject: string, bodyLabel?: string): CodePreviewMessagePresenter =>
  (_message, _options, theme) => ({
    name: "agent_report",
    summary: { subject, outcome: "success" },
    ...(bodyLabel !== undefined && { bodyLabel }),
    expanded: () => expandedAuthoredText(theme, undefined, "Found 3 stale references"),
  });

const STYLES = ["compact", "preview"] as const;
const MODES = ["border", "on", "off"] as const;

describe("message shell", () => {
  beforeAll(() => initTheme("dark", false));

  for (const style of STYLES)
    for (const mode of MODES)
      it(`frames the heading and words in ${style} style with background ${mode}`, () =>
        withPresentationSettings(
          { toolCallCollapsedStyle: style, toolCallBackground: mode },
          () => {
            const before = JSON.stringify(message);
            const render = withCodePreviewMessageShell(present);
            const collapsed = draw(render, false);
            const expanded = draw(render, true);
            expect(collapsed).toContain("MESSAGE SUBJECT");
            // A collapsed compact message is its heading row alone; preview keeps bounded words.
            if (style === "compact") {
              expect(Str.split(collapsed, "\n")).toHaveLength(1);
              expect(collapsed).not.toContain(WORDS[0]);
            } else {
              expect(collapsed).toContain(WORDS[0]);
              // Narrow widths still draw without losing the words.
              expect(draw(render, false, message, 12)).toContain("line");
            }
            expect(collapsed).not.toContain(WORDS[29]);
            expect(expanded).toContain(WORDS[0]);
            expect(expanded).toContain(WORDS[29]);
            expect(Str.split(expanded, "\n").length).toBeGreaterThan(
              Str.split(collapsed, "\n").length,
            );
            expect(draw(render, true, message, 4).length).toBeGreaterThan(0);
            expect(JSON.stringify(message)).toBe(before);
          },
        ));

  it("follows the appearance another copy of the settings published", () =>
    withPresentationSettings(
      { toolCallCollapsedStyle: "preview", toolCallBackground: "on" },
      () => {
        const render = withCodePreviewMessageShell(present);
        const local = draw(render, false);
        // A load in another module copy publishes the user's appearance; this copy never loaded.
        publishSharedPresentation({
          toolCallCollapsedStyle: "compact",
          toolCallBackground: "border",
        });
        const shared = draw(render, false);
        expect(shared).not.toBe(local);
        expect(shared).toBe(
          withPresentationSettings(
            { toolCallCollapsedStyle: "compact", toolCallBackground: "border" },
            () => draw(withCodePreviewMessageShell(present), false),
          ),
        );
      },
    ));

  it("lets an expanded body leave out a subject only its heading showed whole", () => {
    const long = Arr.join(Arr.replicate("word", 60), " ");
    const repeats = (style: "compact" | "preview", subject: string) =>
      Fn.pipe(
        withPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: "off" }, () =>
          draw(withCodePreviewMessageShell(subjectBody(subject)), true, message, 57),
        ),
        Str.includes("SUBJECT AGAIN"),
      );
    expect(repeats("compact", "A short subject")).toBe(false);
    // A subject too long for the heading's rows is shortened there, so the body keeps it.
    expect(repeats("compact", long)).toBe(true);
    // An expanded preview heading wraps a subject of any length whole.
    expect(repeats("preview", "A short subject")).toBe(false);
    expect(repeats("preview", long)).toBe(false);
  });

  it("keeps a subject a collapsed heading showed only in its short form", () => {
    const repeats = (style: "compact" | "preview", compactSubject?: string) =>
      Fn.pipe(
        withPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: "off" }, () =>
          draw(
            withCodePreviewMessageShell(() => ({
              name: "example",
              summary: {
                subject: "auth-review, db-migration",
                ...(compactSubject !== undefined && { compactSubject }),
                outcome: "success",
              },
              collapsed: (headingState) => ({
                render: () =>
                  headingShowedSubject(headingState) ? ["BODY"] : ["BODY", "SUBJECT AGAIN"],
                invalidate: () => undefined,
              }),
            })),
            false,
          ),
        ),
        Str.includes("SUBJECT AGAIN"),
      );
    // Only preview style draws a collapsed body.
    expect(repeats("preview")).toBe(false);
    expect(repeats("preview", "2 subagents")).toBe(true);
  });

  it("labels a delivered message's words beneath a heading that wraps", () => {
    const labeled = (style: "compact" | "preview", sender: string) =>
      withPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: "off" }, () =>
        Arr.some(
          Str.split(draw(withCodePreviewMessageShell(delivered(sender)), true, message, 57), "\n"),
          (row) => Str.trim(row) === "Message",
        ),
      );
    const long = "checkout redesign review for the acme platform team and billing";
    for (const style of STYLES) {
      expect(labeled(style, "web")).toBe(false);
      expect(labeled(style, long)).toBe(true);
    }
  });

  it("labels a message's words with its own body label beneath a heading that wraps", () => {
    const labels = (style: "compact" | "preview", subject: string, bodyLabel?: string) =>
      withPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: "off" }, () =>
        Arr.filter(
          Arr.map(
            Str.split(
              draw(withCodePreviewMessageShell(reported(subject, bodyLabel)), true, message, 57),
              "\n",
            ),
            Str.trim,
          ),
          (row) => row === "Report" || row === "Message",
        ),
      );
    const long = "billing-ledger-reconciliation-review-follow-up-for-the-platform-v2";
    for (const style of STYLES) {
      expect(labels(style, "web", "Report")).toEqual([]);
      expect(labels(style, long, "Report")).toEqual(["Report"]);
      // Without a body label or a delivered message's icon, the words stay unlabeled.
      expect(labels(style, long)).toEqual([]);
    }
  });

  it("falls back to the message's text when a presenter or body throws", () => {
    const failing = withCodePreviewMessageShell(() => {
      throw new Error("presenter failed");
    });
    const failingBody = withCodePreviewMessageShell(() => ({
      name: "example",
      summary: { subject: "MESSAGE SUBJECT", outcome: "returned" },
      collapsed: () => ({
        render: () => {
          throw new Error("body failed");
        },
        invalidate: () => undefined,
      }),
    }));
    const failingCallback = withCodePreviewMessageShell(() => ({
      name: "example",
      summary: { subject: "MESSAGE SUBJECT", outcome: "returned" },
      collapsed: () => {
        throw new Error("callback failed");
      },
    }));
    for (const style of STYLES)
      for (const mode of MODES)
        withPresentationSettings(
          { toolCallCollapsedStyle: style, toolCallBackground: mode },
          () => {
            // A collapsed compact message draws no body, so only a failing presenter falls back.
            for (const render of style === "compact"
              ? [failing]
              : [failing, failingBody, failingCallback])
              expect(draw(render, false)).toContain("FULL MODEL-FACING CONTENT");
            for (const render of [failingBody, failingCallback])
              expect(draw(render, true)).toContain("FULL MODEL-FACING CONTENT");
          },
        );
    const hostile = customMessage({ content: [{ type: "text", text: "safe\u001b[31m text" }] });
    expect(draw(failing, false, hostile)).not.toContain("\u001b");
  });

  it("draws native attachments unchanged below the frame", () => {
    const widths: number[] = [];
    const image: Component = {
      render: (width) => {
        widths.push(width);
        return ["\u001b_Gnative-image-sequence\u001b\\"];
      },
      invalidate: () => undefined,
    };
    for (const style of STYLES)
      for (const mode of MODES)
        withPresentationSettings(
          { toolCallCollapsedStyle: style, toolCallBackground: mode },
          () => {
            const render = withCodePreviewMessageShell(() => ({
              name: "example",
              summary: { subject: "MESSAGE SUBJECT", outcome: "success" },
              collapsed: () => lines(["words"]),
              attachments: [image],
            }));
            for (const expanded of [false, true]) {
              const rows = drawMessage(render, expanded, message);
              expect(rows).toContain("\u001b_Gnative-image-sequence\u001b\\");
              expect(widths.at(-1)).toBe(80);
            }
          },
        );
  });
});
