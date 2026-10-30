import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
} from "pi-code-previews/testing";
import {
  contractEnvelope,
  SESSION_TOOL,
  type SessionRefusal,
  type SessionToolDetails,
  type SessionToolName,
} from "../src/tools/contract.ts";
import { registerSessionTools } from "../src/tools/register.ts";
import { listText, readText, refusalText, sendText } from "../src/tools/text.ts";

const restoreSettings = applyPresentationSettings({});
afterEach(restoreSettings);

const web = { sessionId: "019a2f6e-web", name: "web work", cwd: "/work/web" };

const toolFor = (name: SessionToolName, style: "compact" | "preview") => {
  applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
  const { tools } = captureRegistrations((pi) =>
    registerSessionTools(pi, { run: () => Promise.reject(new Error("not executed")) }),
  );
  return Option.getOrThrow(Arr.findFirst(tools, (tool) => tool.name === name));
};

const result = (
  text: string,
  details: SessionToolDetails,
  isError = false,
): AgentToolResult<SessionToolDetails> => ({
  content: [{ type: "text", text }],
  details,
  ...(isError && { isError: true }),
});

const delivered = {
  ...contractEnvelope,
  tool: SESSION_TOOL.send,
  outcome: "delivered",
  session: web,
  disposition: "woken",
} as const;

const refused = (tool: SessionRefusal["tool"], code: SessionRefusal["code"]) => {
  const details: SessionRefusal = {
    ...contractEnvelope,
    tool,
    outcome: "refused",
    code,
    to: web.sessionId,
    session: web,
  };
  return result(refusalText(details), details, true);
};

const read = {
  ...contractEnvelope,
  tool: SESSION_TOOL.read,
  session: web,
  text: "The web tests pass.\nI fixed the header snapshot.",
  truncated: false,
  state: "idle",
} as const;

const listing = {
  ...contractEnvelope,
  tool: SESSION_TOOL.list,
  sessions: [{ ...web, state: "idle", duplicate: false }],
  omitted: 0,
} as const;

const message = "Can you rerun the web tests?\nThe endpoint moved to /v2/items.";

const scenarios = [
  { tool: SESSION_TOOL.list, args: {}, result: result(listText(listing), listing) },
  {
    tool: SESSION_TOOL.send,
    args: { to: web.sessionId, message },
    result: result(sendText(delivered), delivered),
  },
  {
    tool: SESSION_TOOL.send,
    args: { to: web.sessionId, message },
    result: result(sendText({ ...delivered, outcome: "uncertain", reason: "timeout" }), {
      ...contractEnvelope,
      tool: SESSION_TOOL.send,
      outcome: "uncertain",
      session: web,
      reason: "timeout",
    }),
  },
  ...Arr.map(
    [
      "session_not_found",
      "session_ambiguous",
      "session_unresponsive",
      "session_message_too_long",
    ] as const,
    (code) => ({
      tool: SESSION_TOOL.send,
      args: { to: web.sessionId, message },
      result: refused(SESSION_TOOL.send, code),
    }),
  ),
  { tool: SESSION_TOOL.read, args: { to: web.sessionId }, result: result(readText(read), read) },
  {
    tool: SESSION_TOOL.read,
    args: { to: web.sessionId },
    result: refused(SESSION_TOOL.read, "session_unresponsive"),
  },
];

describe("session tool rows", () => {
  it.each(["compact", "preview"] as const)(
    "show the session by name and keep the agent's procedures out in %s style",
    (style) => {
      for (const scenario of scenarios) {
        const harness = createToolPresentationHarness(toolFor(scenario.tool, style));
        for (const { expanded, text } of harness.cycle(scenario.args, scenario.result, {
          states: [false, true],
        })) {
          if (scenario.tool !== SESSION_TOOL.list) expect(text).toContain("web work");
          // Only a compact heading names the tool; nothing below it names one to call.
          const [, ...below] = Arr.filter(Str.split(text, "\n"), (line) => Str.trim(line) !== "");
          expect(Arr.join(below, "\n")).not.toContain("session_");
          if (expanded) expect(text).toContain(web.sessionId);
        }
      }
    },
  );

  it("shows a sent message with its line breaks collapsed, and the recipient's state only when unusual", () => {
    const harness = createToolPresentationHarness(toolFor(SESSION_TOOL.send, "preview"));
    harness.call({ to: web.sessionId, message });
    harness.result(result(sendText(delivered), delivered));
    const woken = harness.render(100);
    expect(woken).toContain("Can you rerun the web tests?");
    expect(woken).toContain("The endpoint moved to /v2/items.");
    expect(woken).not.toContain(web.sessionId);

    const held = { ...delivered, disposition: "held" } as const;
    const holding = createToolPresentationHarness(toolFor(SESSION_TOOL.send, "preview"));
    holding.call({ to: web.sessionId, message });
    holding.result(result(sendText(held), held));
    expect(holding.render(100).length).toBeGreaterThan(woken.length);
  });

  it("bounds a long message collapsed and shows all of it expanded", () => {
    const lines = Arr.makeBy(30, (index) => `line ${index + 1}`);
    const args = { to: web.sessionId, message: Arr.join(lines, "\n") };
    const harness = createToolPresentationHarness(toolFor(SESSION_TOOL.send, "preview"));
    const [collapsed, expanded] = harness.cycle(args, result(sendText(delivered), delivered), {
      states: [false, true],
    });
    expect(collapsed?.text).toContain("line 1");
    expect(collapsed?.text).not.toContain("line 30");
    expect(Str.split(collapsed?.text ?? "", "\n").length).toBeLessThan(15);
    expect(expanded?.text).toContain("line 30");
  });

  it("falls back to the result text when its details don't decode", () => {
    const harness = createToolPresentationHarness(toolFor(SESSION_TOOL.read, "preview"));
    const [, expanded] = harness.cycle(
      { to: web.sessionId },
      { content: [{ type: "text", text: "Saved reply text" }], details: { version: 99 } },
      { states: [false, true] },
    );
    expect(expanded?.text).toContain("Saved reply text");
  });
});
