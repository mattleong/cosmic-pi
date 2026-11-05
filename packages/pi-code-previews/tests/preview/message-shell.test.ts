import { initTheme, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { stripAnsi } from "pi-cosmic-core";
import { keybindingHintsFixture, plainTheme } from "pi-cosmic-core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  headingShowedSubject,
  withCodePreviewMessageShell,
  type CodePreviewMessagePresenter,
} from "../../index";
import { withPresentationSettings } from "../../testing";
import { publishSharedPresentation } from "../../src/config/state";

type Message = Parameters<MessageRenderer>[0];

const WORDS = Arr.map(Arr.range(1, 30), (line) => `line ${line} of what the agent wrote`);

const message: Message = {
  role: "custom",
  customType: "example-message",
  content: [{ type: "text", text: "FULL MODEL-FACING CONTENT" }],
  display: true,
  details: { words: WORDS },
  timestamp: 0,
};

const lines = (rows: ReadonlyArray<string>): Component => new Text(Arr.join(rows, "\n"), 0, 0);

const present: CodePreviewMessagePresenter = () => ({
  name: "example",
  label: "Example",
  summary: { subject: "MESSAGE SUBJECT", outcome: "returned" },
  collapsed: () => lines([...WORDS.slice(0, 10), "more on expand"]),
  expanded: () => lines(WORDS),
  expandLabel: "message",
});

const draw = (
  render: MessageRenderer,
  expanded: boolean,
  input: Message = message,
  width = 80,
): string =>
  stripAnsi(
    Arr.join(
      render(input, { ...keybindingHintsFixture, expanded, outputPad: 1 }, plainTheme)?.render(
        width,
      ) ?? [],
      "\n",
    ),
  );

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
            expect(collapsed).toContain(WORDS[0]);
            expect(collapsed).not.toContain(WORDS[29]);
            expect(expanded).toContain(WORDS[29]);
            expect(Str.split(expanded, "\n").length).toBeGreaterThan(
              Str.split(collapsed, "\n").length,
            );
            // Narrow widths still draw without losing the words.
            expect(draw(render, false, message, 12)).toContain("line");
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

  it("keeps a compact message without a collapsed body to its heading until expanded", () =>
    withPresentationSettings(
      { toolCallCollapsedStyle: "compact", toolCallBackground: "border" },
      () => {
        const render = withCodePreviewMessageShell(() => ({
          name: "example",
          summary: { subject: "MESSAGE SUBJECT", outcome: "success" },
          expanded: () => lines(WORDS),
          expandLabel: "message",
        }));
        const collapsed = draw(render, false);
        expect(collapsed).toContain("MESSAGE SUBJECT");
        expect(collapsed).not.toContain(WORDS[0]);
        expect(draw(render, true)).toContain(WORDS[29]);
      },
    ));

  it("lets an expanded body leave out a subject only its heading showed whole", () => {
    const long = Arr.join(Arr.replicate("word", 60), " ");
    const repeats = (style: "compact" | "preview", subject: string) =>
      Str.includes("SUBJECT AGAIN")(
        withPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: "off" }, () =>
          draw(withCodePreviewMessageShell(subjectBody(subject)), true, message, 57),
        ),
      );
    expect(repeats("compact", "A short subject")).toBe(false);
    // A subject too long for the heading's rows is shortened there, so the body keeps it.
    expect(repeats("compact", long)).toBe(true);
    // An expanded preview heading wraps its subject whole, unless it is too long to show.
    expect(repeats("preview", "A short subject")).toBe(false);
    expect(repeats("preview", long)).toBe(true);
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
            for (const render of [failing, failingBody, failingCallback])
              expect(draw(render, false)).toContain("FULL MODEL-FACING CONTENT");
          },
        );
    const hostile: Message = {
      ...message,
      content: [{ type: "text", text: "safe\u001b[31m text" }],
    };
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
              const rows = render(
                message,
                { ...keybindingHintsFixture, expanded, outputPad: 1 },
                plainTheme,
              ).render(80);
              expect(rows).toContain("\u001b_Gnative-image-sequence\u001b\\");
              expect(widths.at(-1)).toBe(80);
            }
          },
        );
  });
});
