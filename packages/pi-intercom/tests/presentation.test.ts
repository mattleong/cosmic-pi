import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  expansionOffers,
} from "pi-code-previews/testing";
import {
  contractEnvelope,
  SESSION_TOOL,
  type SessionRefusal,
  type SessionToolArgs,
  type SessionToolDetails,
  type SessionToolName,
} from "../src/tools/contract.ts";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { plainTheme } from "pi-cosmic-core/testing";
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

const dimmed = (text: string) => `\u001b[2m${text}\u001b[22m`;

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
    // Each line of the message keeps its own row, wherever the body indents it.
    expect(Arr.map(woken, Str.trim)).toContain("Can you rerun the web tests?");
    expect(Arr.map(woken, Str.trim)).toContain("The endpoint moved to /v2/items.");
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

  it("keeps a read reply for expansion in compact style, rendered as markdown", () => {
    const reply = { ...read, text: "Use `pnpm test` now.\nThen **lint**." } as const;
    const harness = createToolPresentationHarness(toolFor(SESSION_TOOL.read, "compact"));
    const [collapsed, expanded] = harness.cycle(
      { to: web.sessionId },
      result(readText(reply), reply),
      { states: [false, true] },
    );
    expect(collapsed?.text).not.toContain("Use pnpm test now.");
    expect(expansionOffers(Str.split(collapsed?.text ?? "", "\n")).length).toBeGreaterThan(0);
    expect(expanded?.text).toContain("Use pnpm test now.");
    expect(expanded?.text).toContain("Then lint.");
  });

  const longName = "checkout redesign review for the acme platform team and billing";

  it.each(["compact", "preview"] as const)(
    "shows a long session name whole in an expanded %s heading",
    (style) => {
      const sentTo = { ...delivered, session: { ...web, name: longName } };
      const harness = createToolPresentationHarness(toolFor(SESSION_TOOL.send, style), {
        width: 57,
      });
      const [, expanded] = harness.cycle(
        { to: web.sessionId, message },
        result(sendText(sentTo), sentTo),
        { states: [false, true] },
      );
      // The heading wraps the whole name; nothing else needs to repeat it.
      const text = stripTerminalControls(expanded?.text ?? "");
      expect(Str.replace(/\s+/gu, " ")(text)).toContain(longName);
    },
  );

  it("ends a narrow listed session's name at a whole word, keeping its state", () => {
    const longListing = {
      ...contractEnvelope,
      tool: SESSION_TOOL.list,
      sessions: [{ ...web, name: longName, state: "busy", duplicate: false }],
      omitted: 0,
    } as const;
    const harness = createToolPresentationHarness(toolFor(SESSION_TOOL.list, "preview"), {
      width: 57,
    });
    const [collapsed] = harness.cycle({}, result(listText(longListing), longListing), {
      states: [false],
    });
    const row = Arr.findFirst(Str.split(collapsed?.text ?? "", "\n"), Str.includes("busy"));
    const label = /^\S+ (.+)… · busy/u.exec(Str.trim(Option.getOrElse(row, () => "")))?.[1] ?? "";
    expect(label).not.toBe("");
    expect(Str.startsWith(`${label} `)(longName)).toBe(true);
  });

  it("dims a wrapped row's leading `·` like the separators between facts", () => {
    const deepListing = {
      ...contractEnvelope,
      tool: SESSION_TOOL.list,
      sessions: [
        {
          ...web,
          name: "checkout redesign review",
          cwd: "/work/acme/platform/services/billing/checkout-redesign-review",
          state: "busy",
          duplicate: true,
        },
      ],
      omitted: 0,
    } as const;
    // The plain theme, except that dim text is marked so the test can see which parts are dim.
    const theme = new Proxy(plainTheme, {
      get: (target, key) =>
        key === "fg"
          ? (color: string, text: string) => (color === "dim" ? dimmed(text) : text)
          : target[key as keyof Theme],
    });
    const harness = createToolPresentationHarness(toolFor(SESSION_TOOL.list, "preview"), {
      width: 57,
      theme,
    });
    const [, expanded] = harness.cycle({}, result(listText(deepListing), deepListing), {
      states: [false, true],
    });
    const led = Arr.filter(Str.split(expanded?.text ?? "", "\n"), (row) =>
      Str.startsWith("· ")(Str.trimStart(stripTerminalControls(row))),
    );
    expect(led.length).toBeGreaterThan(0);
    for (const row of led) expect(Str.startsWith(dimmed("·"))(Str.trimStart(row))).toBe(true);
  });

  it("leads a wrapped name's facts row with `·` when its facts don't all fit beside the name", () => {
    const longNameListing = {
      ...contractEnvelope,
      tool: SESSION_TOOL.list,
      sessions: [
        {
          ...web,
          name: "checkout redesign review for the acme platform team and billing and the support desks",
          cwd: "/srv/checkout/web",
          state: "busy",
          duplicate: false,
        },
      ],
      omitted: 0,
    } as const;
    const harness = createToolPresentationHarness(toolFor(SESSION_TOOL.list, "preview"), {
      width: 57,
    });
    const [, expanded] = harness.cycle({}, result(listText(longNameListing), longNameListing), {
      states: [false, true],
    });
    const rows = Arr.map(Str.split(stripTerminalControls(expanded?.text ?? ""), "\n"), (row) =>
      Str.trimStart(row),
    );
    const directoryRow = Arr.findFirst(rows, Str.includes("/srv/checkout/web"));
    expect(Option.map(directoryRow, Str.startsWith("· "))).toEqual(Option.some(true));
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

const rowsOf = (text: string | undefined) =>
  Arr.filter(Str.split(stripTerminalControls(text ?? ""), "\n"), (row) =>
    Str.isNonEmpty(Str.trim(row)),
  );

describe("collapsed compact session rows", () => {
  const cycle = (
    tool: SessionToolName,
    args: SessionToolArgs,
    settled: AgentToolResult<SessionToolDetails>,
  ) =>
    createToolPresentationHarness(toolFor(tool, "compact"), { width: 140 }).cycle(args, settled, {
      states: [false, true],
    });
  const api = { sessionId: "019a2f6e-api", name: "api work", cwd: "/work/api" };

  it("lists sessions on one neutral row, counting states only where they differ", () => {
    const twoIdle = {
      ...listing,
      sessions: [
        { ...web, state: "idle", duplicate: false },
        { ...api, state: "idle", duplicate: false },
      ],
    } as const;
    const mixed = {
      ...twoIdle,
      sessions: [twoIdle.sessions[0], { ...api, state: "busy", duplicate: false }],
    } as const;
    const [same] = cycle(SESSION_TOOL.list, {}, result(listText(twoIdle), twoIdle));
    const [differ, expanded] = cycle(SESSION_TOOL.list, {}, result(listText(mixed), mixed));
    for (const frame of [same, differ]) {
      const rows = rowsOf(frame?.text);
      expect(rows).toHaveLength(1);
      expect(Str.trim(rows[0] ?? "")).toMatch(/^• session_list · /u);
    }
    expect(same?.text).toContain("2 sessions");
    expect(differ?.text).toMatch(/1 idle.*1 busy/u);
    // Expanded, every session is listed, then their ids.
    for (const session of [web, api]) {
      expect(expanded?.text).toContain(session.name);
      expect(expanded?.text).toContain(session.sessionId);
    }
  });

  it("reads neutrally, with the session's state and its reply only expanded", () => {
    const [collapsed, expanded] = cycle(
      SESSION_TOOL.read,
      { to: web.sessionId },
      result(readText(read), read),
    );
    const rows = rowsOf(collapsed?.text);
    expect(rows).toHaveLength(1);
    expect(Str.trim(rows[0] ?? "")).toMatch(/^• session_read web work · idle/u);
    expect(expansionOffers(rows)).toEqual(["reply"]);
    expect(expanded?.text).toContain("I fixed the header snapshot.");
  });

  it("offers a sent message behind its one row", () => {
    const [collapsed, expanded] = cycle(
      SESSION_TOOL.send,
      { to: web.sessionId, message },
      result(sendText(delivered), delivered),
    );
    const rows = rowsOf(collapsed?.text);
    expect(rows).toHaveLength(1);
    expect(expansionOffers(rows)).toEqual(["message"]);
    expect(expanded?.text).toContain("The endpoint moved to /v2/items.");
  });
});
