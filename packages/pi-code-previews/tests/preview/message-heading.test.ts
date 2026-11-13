import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { beforeEach, expect, test } from "vitest";
import { previewIssuesSlot, previewMessageHeading } from "../../index";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { plainTheme, stripAnsi, textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: false }),
);

const name = "checkout redesign review for the acme platform team and billing";
const message = "Can you rerun the web tests after my API change?";

const tool = () =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: (_args, theme, context) => {
        const call = new Container();
        call.addChild(previewMessageHeading(() => ({ title: "Message →", name }), theme, context));
        call.addChild(previewIssuesSlot(context));
        call.addChild(new Text(`  ${message}`, 0, 0));
        return call;
      },
      renderResult: () => new Container(),
    },
    { compactSummary: () => ({ subject: name }) },
  );

const draw = (expanded: boolean, width: number) => {
  const harness = createToolPresentationHarness(tool());
  harness.call({ path: "a.ts" }, { executionStarted: true, expanded });
  harness.result(textResult("sent"), { expanded });
  return Arr.map(harness.render(width), (row) => Str.trimEnd(stripAnsi(row)));
};

test("a collapsed message heading is one row, its name cut at a word boundary", () => {
  for (const width of [40, 57]) {
    const rows = draw(false, width);
    const heading = rows[0] ?? "";
    expect(visibleWidth(heading)).toBeLessThanOrEqual(width);
    expect(heading).toMatch(/…$/u);
    // The cut keeps whole words, and the message follows on the next row.
    expect(`${name} `).toContain(`${/^Message → (.*)…$/u.exec(heading)?.[1] ?? "-"} `);
    expect(rows[1]).toMatch(/^ +Can you rerun/u);
  }
});

test("an expanded message heading wraps with the name whole", () => {
  const rows = draw(true, 57);
  const end = Option.getOrElse(
    Arr.findFirstIndex(rows, (row) => Fn.pipe(row, Str.includes(message))),
    () => rows.length,
  );
  const heading = Arr.join(Arr.map(Arr.take(rows, end), Str.trim), " ");
  expect(heading).toContain(`Message → ${name}`);
  expect(heading).not.toContain("…");
});

test("a collapsed message heading without a name shows the title alone", () => {
  const heading = previewMessageHeading(() => ({ title: "Message" }), plainTheme, {
    expanded: false,
    state: {},
  });
  expect(Arr.map(heading.render(57), stripAnsi)).toEqual(["Message"]);
});
