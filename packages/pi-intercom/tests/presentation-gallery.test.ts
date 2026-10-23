import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  writeGallerySection,
} from "pi-code-previews/testing";
import { frameMessage, INTERCOM_MESSAGE_TYPE } from "../src/delivery.ts";
import { renderIntercomMessage } from "../src/message.ts";
import {
  contractEnvelope,
  SESSION_TOOL,
  type SessionListContract,
  type SessionReadContract,
  type SessionRefusal,
  type SessionSendDetails,
  type SessionToolDetails,
} from "../src/tools/contract.ts";
import { registerSessionTools } from "../src/tools/register.ts";
import { listText, readText, refusalText, sendText } from "../src/tools/text.ts";

const web = { sessionId: "019a2f6e-web", name: "web work", cwd: "/Users/example/web" };
const api = { sessionId: "019a2f6e-api", cwd: "/Users/example/api" };

const result = (
  text: string,
  details: SessionToolDetails,
  isError = false,
): AgentToolResult<SessionToolDetails> => ({
  content: [{ type: "text", text }],
  details,
  ...(isError && { isError: true }),
});

const listing: SessionListContract = {
  ...contractEnvelope,
  tool: SESSION_TOOL.list,
  sessions: [
    { ...api, state: "busy", duplicate: false },
    { ...web, state: "idle", duplicate: false },
    {
      sessionId: "019a2f6e-reloading",
      cwd: "/Users/example/reloading",
      state: "unavailable",
      duplicate: false,
    },
    {
      sessionId: "019a2f6e-old",
      cwd: "/Users/example/old",
      state: "unresponsive",
      duplicate: false,
    },
    {
      sessionId: "019a2f6e-gone",
      cwd: "/Users/example/gone",
      state: "unreachable",
      duplicate: false,
    },
  ],
  omitted: 0,
};

const sent = (disposition: "woken" | "queued" | "held"): SessionSendDetails => ({
  ...contractEnvelope,
  tool: SESSION_TOOL.send,
  outcome: "delivered",
  session: web,
  disposition,
});

const uncertain: SessionSendDetails = {
  ...contractEnvelope,
  tool: SESSION_TOOL.send,
  outcome: "uncertain",
  session: web,
  reason: "timeout",
};

const read: SessionReadContract = {
  ...contractEnvelope,
  tool: SESSION_TOOL.read,
  session: web,
  text: "The web tests pass.\n\nI also fixed the flaky snapshot in header.test.ts.",
  truncated: false,
  state: "idle",
};

const refused = (tool: SessionRefusal["tool"], code: SessionRefusal["code"], to: string) => {
  const details: SessionRefusal = {
    ...contractEnvelope,
    tool,
    outcome: "refused",
    code,
    to,
    ...(to === web.sessionId && { session: web }),
  };
  return result(refusalText(details), details, true);
};

const message =
  "Can you rerun the web tests after my API change?\nThe endpoint moved to /v2/items.";
const scenarios = [
  {
    title: "listed sessions",
    tool: SESSION_TOOL.list,
    args: {},
    result: result(listText(listing), listing),
  },
  {
    title: "sent to an idle session",
    tool: SESSION_TOOL.send,
    args: { to: web.sessionId, message },
    result: result(sendText(sent("woken")), sent("woken")),
  },
  {
    title: "sent to a session holding messages",
    tool: SESSION_TOOL.send,
    args: { to: web.sessionId, message },
    result: result(sendText(sent("held")), sent("held")),
  },
  {
    title: "send timed out",
    tool: SESSION_TOOL.send,
    args: { to: web.sessionId, message },
    result: result(sendText(uncertain), uncertain),
  },
  {
    title: "receiving turned off",
    tool: SESSION_TOOL.send,
    args: { to: web.sessionId, message },
    result: refused(SESSION_TOOL.send, "session_receive_disabled", web.sessionId),
  },
  {
    title: "read a session that didn't answer in time",
    tool: SESSION_TOOL.read,
    args: { to: web.sessionId },
    result: refused(SESSION_TOOL.read, "session_unresponsive", web.sessionId),
  },
  {
    title: "read a session that is reloading",
    tool: SESSION_TOOL.read,
    args: { to: web.sessionId },
    result: refused(SESSION_TOOL.read, "session_unavailable", web.sessionId),
  },
  {
    title: "unknown session",
    tool: SESSION_TOOL.send,
    args: { to: "019a2f6e-nope", message },
    result: refused(SESSION_TOOL.send, "session_not_found", "019a2f6e-nope"),
  },
  {
    title: "read the latest reply",
    tool: SESSION_TOOL.read,
    args: { to: web.sessionId },
    result: result(readText(read), read),
  },
  {
    title: "read a duplicate id",
    tool: SESSION_TOOL.read,
    args: { to: "019a2f6e-twin" },
    result: refused(SESSION_TOOL.read, "session_ambiguous", "019a2f6e-twin"),
  },
] as const;

const inbound = {
  from: { sessionId: web.sessionId, name: web.name, cwd: web.cwd },
  messageId: "message-1",
  text: message,
};

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders session tools and inbound messages in both collapsed styles", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const { tools } = captureRegistrations((pi) =>
            registerSessionTools(pi, { run: () => Promise.reject(new Error("not executed")) }),
          );
          for (const scenario of scenarios) {
            const tool = tools.find(({ name }) => name === scenario.tool);
            if (!tool) continue;
            lines.push(
              ...galleryFrames(tool, {
                title: `${style} · ${scenario.title}`,
                args: scenario.args,
                result: scenario.result,
                isError: scenario.result.isError === true,
              }),
            );
          }
          lines.push(
            ...galleryFrames(tools[1]!, {
              title: `${style} · sending`,
              args: { to: web.sessionId, message },
              phase: "running",
            }),
            ...galleryMessageFrames(renderIntercomMessage, {
              title: `${style} · message from another session`,
              message: {
                role: "custom",
                customType: INTERCOM_MESSAGE_TYPE,
                content: frameMessage(inbound),
                display: true,
                details: { from: inbound.from, messageId: inbound.messageId },
                timestamp: 0,
              },
            }),
          );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-intercom", lines);
    }),
  );
});
