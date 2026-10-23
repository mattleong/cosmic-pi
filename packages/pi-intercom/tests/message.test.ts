import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { plainTheme } from "pi-cosmic-core/testing";
import { frameMessage, INTERCOM_MESSAGE_TYPE } from "../src/delivery.ts";
import { renderIntercomMessage } from "../src/message.ts";

const from = { sessionId: "peer-session", name: "api work", cwd: "/work/api" };

const collapsed = (text: string) => {
  const component = renderIntercomMessage(
    {
      role: "custom",
      customType: INTERCOM_MESSAGE_TYPE,
      content: frameMessage({ from, messageId: "message-1", text }),
      display: true,
      details: { from, messageId: "message-1" },
      timestamp: 0,
    },
    { expanded: false, outputPad: 1 },
    plainTheme,
  );
  return (width: number) => component?.render(width) ?? [];
};

describe("intercom message", () => {
  it("shows the sender and the first line they wrote, fitted to each width", () => {
    const render = collapsed("\n \u001b[31m\u001b[0m\t\n  Please   rerun\tthe tests.\nThen lint.");

    const wide = Arr.join(render(160), "\n");
    expect(wide).toContain("api work");
    expect(wide).toContain("Please rerun the tests.");
    expect(wide).not.toContain("Then lint.");
    for (const width of [160, 24, 160, 24])
      for (const line of render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
