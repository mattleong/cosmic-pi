import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { applyPresentationSettings } from "pi-code-previews/testing";
import { plainTheme } from "pi-cosmic-core/testing";
import {
  frameMessage,
  INTERCOM_MESSAGE_TYPE,
  type IntercomMessageDetails,
} from "../src/delivery.ts";
import { renderIntercomMessage } from "../src/message.ts";

const restoreSettings = applyPresentationSettings({});
afterEach(restoreSettings);

const from = { sessionId: "peer-session", name: "api work", cwd: "/work/api" };

const render = (
  text: string,
  expanded: boolean,
  details: Partial<IntercomMessageDetails> = { from, messageId: "message-1", text },
) => {
  const component = renderIntercomMessage(
    {
      role: "custom",
      customType: INTERCOM_MESSAGE_TYPE,
      content: frameMessage({ from, messageId: "message-1", text }),
      display: true,
      details,
      timestamp: 0,
    },
    { expanded, outputPad: 1 },
    plainTheme,
  );
  return (width: number) => component?.render(width) ?? [];
};

describe("intercom message", () => {
  it.each(["compact", "preview"] as const)(
    "shows the sender and what they wrote, never the frame's reply instructions, in %s style",
    (style) => {
      applyPresentationSettings({ toolCallCollapsedStyle: style });
      const text = "\u001b[31mPlease\u001b[0m rerun the tests.\nThen lint.";
      for (const expanded of [false, true]) {
        const shown = Arr.join(render(text, expanded)(160), "\n");
        expect(shown).toContain("api work");
        expect(shown).toContain("Please rerun the tests.");
        expect(shown).not.toContain("\u001b");
        expect(shown).not.toContain("session_send");
        if (expanded || style === "preview") expect(shown).toContain("Then lint.");
        if (expanded) expect(shown).toContain(from.sessionId);
      }
    },
  );

  it("bounds a long message collapsed and fits each width", () => {
    applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
    const text = Arr.join(
      Arr.makeBy(40, (index) => `line ${index + 1}`),
      "\n",
    );
    const collapsed = render(text, false);
    expect(Arr.join(collapsed(160), "\n")).not.toContain("line 40");
    expect(collapsed(160).length).toBeLessThan(15);
    for (const width of [160, 24, 160, 24])
      for (const row of collapsed(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    expect(Arr.join(render(text, true)(160), "\n")).toContain("line 40");
  });

  it("shows a stored message without display text only by its sender until expanded", () => {
    applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
    const legacy = { from, messageId: "message-1" };
    expect(Arr.join(render("Please rerun.", false, legacy)(160), "\n")).not.toContain(
      "Please rerun.",
    );
    expect(Arr.join(render("Please rerun.", true, legacy)(160), "\n")).toContain("Please rerun.");
    expect(Arr.join(render("Please rerun.", false, {})(160), "\n")).toContain("another session");
  });
});
