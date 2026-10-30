import {
  CustomMessageComponent,
  initTheme,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { stripAnsi } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { withCodePreviewMessageShell, type CodePreviewMessagePresenter } from "../../index";
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
    Arr.join(render(input, { expanded, outputPad: 1 }, plainTheme)?.render(width) ?? [], "\n"),
  );

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
            if (style === "compact") {
              // Collapsed, it is a bare compact row with its words beneath, as compact tool rows are.
              const rows = Str.split(collapsed, "\n");
              expect(rows).toHaveLength(1 + 11);
              expect(rows[0]).toContain("MESSAGE SUBJECT");
              expect(Str.startsWith(" ")(rows[1] ?? "")).toBe(true);
              // Expanded, it keeps the frame an expanded compact tool row has.
              if (mode !== "off")
                expect(Str.split(expanded, "\n").length).toBeGreaterThan(1 + WORDS.length);
            }
            // Narrow widths still draw without losing the words.
            expect(draw(render, false, message, 12)).toContain("line");
            expect(draw(render, true, message, 4).length).toBeGreaterThan(0);
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
              const rows = render(message, { expanded, outputPad: 1 }, plainTheme).render(80);
              expect(rows).toContain("\u001b_Gnative-image-sequence\u001b\\");
              expect(widths.at(-1)).toBe(80);
            }
          },
        );
  });

  it("leaves message content unchanged and adds no spacing of its own beside Pi's", () => {
    const before = JSON.stringify(message);
    for (const style of STYLES)
      for (const mode of MODES)
        withPresentationSettings(
          { toolCallCollapsedStyle: style, toolCallBackground: mode },
          () => {
            const render = withCodePreviewMessageShell(present);
            for (const expanded of [false, true]) {
              const row = new CustomMessageComponent(message, render, undefined, 1);
              row.setExpanded(expanded);
              const rows = Arr.map(row.render(80), (line) => Str.trim(stripAnsi(line)));
              // Pi's own spacer is the only blank row before the message, as before a tool row.
              expect(rows[0]).toBe("");
              expect(Str.isNonEmpty(rows[1] ?? "") || mode === "on").toBe(true);
            }
          },
        );
    expect(JSON.stringify(message)).toBe(before);
  });
});
