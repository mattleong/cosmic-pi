import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import {
  currentProcessIdentity,
  nodeFilePlatformLayer,
  synchronousRandomHex,
} from "pi-cosmic-core";
import { connect, createServer } from "node:net";
import { afterEach, vi } from "vitest";
import { INTERCOM_MESSAGE_TYPE } from "../src/delivery.ts";
import type { intercomLayer } from "../src/layer.ts";
import { SessionRecordFromJson, sessionRecord } from "../src/registry/schema.ts";
import {
  decodeSessionToolDetails,
  SESSION_TOOL,
  type SessionToolDetails,
  type ToolRefusalCode,
} from "../src/tools/contract.ts";
import {
  listSessions,
  OwnerLiveness,
  readSession,
  sendToSession,
  SessionToolRefusal,
} from "../src/tools/sessions.ts";
import { refusalIssue, uncertainIssue } from "../src/tools/summary.ts";
import {
  assistantEntry,
  harness,
  onlyRecord,
  sessionRuntime,
  sharedAgentDirectory,
} from "./support/session-harness.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const detailsOf = (result: AgentToolResult<unknown>): SessionToolDetails => {
  const decoded = decodeSessionToolDetails(result.details);
  return Option.getOrThrowWith(decoded, () => new Error("The result has no session tool details."));
};

/** Two sessions of one user: `a` is the caller, `b` the other session. */
const twoSessions = Effect.gen(function* () {
  const shared = yield* sharedAgentDirectory();
  const a = yield* harness({ shared, sessionId: "session-a", sessionName: "api work" });
  yield* a.start();
  const b = yield* harness({ shared, sessionId: "session-b", sessionName: "web work" });
  yield* b.start();
  return { shared, a, b };
});

/**
 * A registry record of a live owner whose socket nobody answers, or `socket` when given, in the
 * registry of the sessions sharing `where.base`.
 */
const writeForeignRecord = (
  where: { readonly base: string; readonly sessions: string },
  sessionId: string,
  options: { readonly socket?: string; readonly pid?: number; readonly token?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const instance = synchronousRandomHex(16);
    const owner = currentProcessIdentity();
    const record = sessionRecord({
      instance,
      pid: options.pid ?? owner.pid,
      started: options.pid === undefined ? owner.started : undefined,
      sessionId,
      name: undefined,
      cwd: "/elsewhere",
      socket: options.socket ?? paths.join(where.base, `${instance}.sock`),
      token: options.token ?? synchronousRandomHex(32),
    });
    const source = yield* Schema.encodeEffect(SessionRecordFromJson)(record);
    yield* fs.writeFileString(paths.join(where.sessions, `${instance}.json`), source, {
      mode: 0o600,
    });
  });

/**
 * Relays connections at `socket` to `target` until a `Deliver` request goes out, then drops both
 * ends, as a recipient that dies mid-request would.
 */
const droppingRelay = (socket: string, target: string) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((client) => {
        const upstream = connect(target);
        const drop = () => {
          client.destroy();
          upstream.destroy();
        };
        client.on("data", (data) => {
          if (data.toString().includes('"tag":"Deliver"')) drop();
          else upstream.write(data);
        });
        upstream.on("data", (data) => client.write(data));
        for (const end of [client, upstream]) {
          end.on("error", () => undefined);
          end.on("close", drop);
        }
      });
      server.listen(socket, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

const unnamedSession = (sessionId: string) => ({ sessionId, name: undefined, cwd: "/project" });

layer(nodeFilePlatformLayer)("intercom session tools", (it) => {
  it.effect("lists other live sessions, marking silent ones and duplicate ids", () =>
    Effect.gen(function* () {
      const { a } = yield* twoSessions;
      yield* writeForeignRecord(a, "silent");
      yield* writeForeignRecord(a, "twin");
      yield* writeForeignRecord(a, "twin");
      yield* writeForeignRecord(a, "dead", { pid: 99_999_999 });

      const result = yield* a.callTool(SESSION_TOOL.list, {});
      const details = detailsOf(result);

      expect(result.structuredContent).toEqual(details);
      if (details.tool !== SESSION_TOOL.list) throw new Error("Expected a listing.");
      expect(
        details.sessions.map(({ sessionId, name, state, duplicate }) => ({
          sessionId,
          name,
          state,
          duplicate,
        })),
      ).toEqual([
        { sessionId: "silent", name: undefined, state: "unresponsive", duplicate: false },
        { sessionId: "twin", name: undefined, state: "unresponsive", duplicate: true },
        { sessionId: "twin", name: undefined, state: "unresponsive", duplicate: true },
        { sessionId: "session-b", name: "web work", state: "idle", duplicate: false },
      ]);
    }),
  );

  it.effect("asks whether an owner runs only for sessions that don't answer", () =>
    Effect.gen(function* () {
      const paths = yield* Path.Path;
      const shared = yield* sharedAgentDirectory();
      yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", shared.agentDirectory));
      const a = yield* sessionRuntime(unnamedSession("session-a"), "From a.", shared.fallbackRoot);
      yield* sessionRuntime(unnamedSession("session-b"), "From b.", shared.fallbackRoot);
      const registry = {
        base: shared.base,
        sessions: paths.join(shared.agentDirectory, "intercom", "sessions"),
      };
      const silentPid = 99_999_998;
      const deadPid = 99_999_999;
      yield* writeForeignRecord(registry, "silent", { pid: silentPid });
      yield* writeForeignRecord(registry, "dead", { pid: deadPid });
      const asked: Array<number> = [];
      const fromA = <X, E>(
        effect: Effect.Effect<X, E, Layer.Success<ReturnType<typeof intercomLayer>>>,
      ) =>
        effect.pipe(
          Effect.provideService(OwnerLiveness, ({ pid }) => {
            asked.push(pid);
            return pid === deadPid ? "dead" : "alive";
          }),
          Effect.provide(a.context),
        );

      const listed = yield* fromA(listSessions());
      expect(listed.sessions.map(({ sessionId, state }) => ({ sessionId, state }))).toEqual([
        { sessionId: "session-b", state: "idle" },
        { sessionId: "silent", state: "unresponsive" },
      ]);
      expect(asked.toSorted((left, right) => left - right)).toEqual([silentPid, deadPid]);

      asked.length = 0;
      expect(yield* fromA(sendToSession("session-b", "Hello."))).toMatchObject({
        outcome: "delivered",
      });
      expect(yield* fromA(readSession("session-b"))).toMatchObject({ text: "From b." });
      expect(asked).toEqual([]);

      const refusal = yield* Effect.flip(fromA(sendToSession("dead", "Hello.")));
      expect(refusal).toBeInstanceOf(SessionToolRefusal);
      expect(refusal).toMatchObject({ code: "session_not_found" });
      expect(asked).toEqual([deadPid]);
    }),
  );

  it.effect("delivers a message that wakes an idle session and queues for a busy one", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoSessions;

      const woken = yield* a.callTool(SESSION_TOOL.send, {
        to: "session-b",
        message: "Can you rerun the web tests?",
      });

      expect(detailsOf(woken)).toMatchObject({ outcome: "delivered", disposition: "woken" });
      const [sent, options] = b.sendMessage.mock.calls[0] ?? [];
      expect(options).toEqual({ triggerTurn: true });
      expect(sent).toMatchObject({
        customType: INTERCOM_MESSAGE_TYPE,
        display: true,
        details: { from: { sessionId: "session-a", name: "api work", cwd: a.base } },
      });
      expect(sent?.content).toContain("Can you rerun the web tests?");

      b.setIdle(false);
      const queued = yield* a.callTool(SESSION_TOOL.send, {
        to: "session-b",
        message: "Also lint.",
      });
      expect(detailsOf(queued)).toMatchObject({ outcome: "delivered", disposition: "queued" });
      expect(b.sendMessage.mock.calls[1]?.[1]).toEqual({ triggerTurn: false });
    }),
  );

  it.effect("reads another session's latest assistant text without disturbing it", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoSessions;
      b.setBranch([assistantEntry("The web tests pass.")]);

      const result = yield* a.callTool(SESSION_TOOL.read, { to: "session-b" });

      expect(result.structuredContent).toMatchObject({
        tool: SESSION_TOOL.read,
        session: { sessionId: "session-b", name: "web work" },
        text: "The web tests pass.",
        truncated: false,
        state: "idle",
      });
      expect(b.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("refuses unknown, duplicate, unreachable, and opted-out sessions", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoSessions;
      yield* writeForeignRecord(a, "twin");
      yield* writeForeignRecord(a, "twin");
      yield* writeForeignRecord(a, "silent");
      const refusal = (tool: string, to: string) =>
        Effect.map(a.callTool(tool, { to, message: "Hello." }), (result) => {
          expect(result.isError).toBe(true);
          const details = detailsOf(result);
          return "code" in details ? details.code : undefined;
        });

      expect(yield* refusal(SESSION_TOOL.send, "session-a")).toBe("session_not_found");
      expect(yield* refusal(SESSION_TOOL.send, "nobody")).toBe("session_not_found");
      expect(yield* refusal(SESSION_TOOL.read, "twin")).toBe("session_ambiguous");
      expect(yield* refusal(SESSION_TOOL.send, "silent")).toBe("session_unreachable");
      expect(yield* refusal(SESSION_TOOL.read, "silent")).toBe("session_unreachable");

      yield* b.command("receive off");
      expect(yield* refusal(SESSION_TOOL.send, "session-b")).toBe("session_receive_disabled");
      yield* b.command("receive on");
      const delivered = yield* a.callTool(SESSION_TOOL.send, { to: "session-b", message: "Hi." });
      expect(detailsOf(delivered)).toMatchObject({ outcome: "delivered" });
    }),
  );

  it.effect("reports a send whose connection drops mid-request as uncertain", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoSessions;
      const paths = yield* Path.Path;
      const socket = paths.join(a.shared.base, "drop.sock");
      const recipient = yield* onlyRecord(
        Effect.map(b.records, (records) =>
          records.filter(({ sessionId }) => sessionId === "session-b"),
        ),
      );
      yield* droppingRelay(socket, recipient.socket);
      yield* writeForeignRecord(a, "flaky", { socket, token: recipient.token });

      const result = yield* a.callTool(SESSION_TOOL.send, { to: "flaky", message: "Hello." });

      expect(result.isError).not.toBe(true);
      expect(detailsOf(result)).toMatchObject({ outcome: "uncertain", reason: "disconnected" });
    }),
  );

  it.effect("refuses a send whose connection drops before the request goes out", () =>
    Effect.gen(function* () {
      const { a } = yield* twoSessions;
      const paths = yield* Path.Path;
      const socket = paths.join(a.shared.base, "early.sock");
      yield* Effect.acquireRelease(
        Effect.callback<ReturnType<typeof createServer>>((resume) => {
          const server = createServer((connection) => {
            connection.once("data", () => connection.destroy());
          });
          server.listen(socket, () => resume(Effect.succeed(server)));
        }),
        (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
      );
      yield* writeForeignRecord(a, "early", { socket });

      const result = yield* a.callTool(SESSION_TOOL.send, { to: "early", message: "Hello." });

      expect(result.isError).toBe(true);
      expect(detailsOf(result)).toMatchObject({ outcome: "refused", code: "session_unreachable" });
    }),
  );

  it.effect("keeps session_send out of codemode scripts", () =>
    Effect.gen(function* () {
      const { a } = yield* twoSessions;
      expect(a.tool(SESSION_TOOL.send).exposure).toBe("model-only");
      expect(a.tool(SESSION_TOOL.list).exposure ?? "direct").toBe("direct");
      expect(a.tool(SESSION_TOOL.read).exposure ?? "direct").toBe("direct");
    }),
  );

  it.effect("lists sessions and toggles receiving from /intercom", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoSessions;

      yield* a.command("list");
      expect(String(a.notify.mock.calls[0]?.[0])).toContain("web work");

      yield* a.command("receive off");
      // Asking for the state leaves it unchanged.
      yield* a.command("receive");
      const refused = yield* b.callTool(SESSION_TOOL.send, { to: "session-a", message: "Hi." });
      expect(detailsOf(refused)).toMatchObject({ code: "session_receive_disabled" });
      yield* a.command("receive on");
      const delivered = yield* b.callTool(SESSION_TOOL.send, { to: "session-a", message: "Hi." });
      expect(detailsOf(delivered)).toMatchObject({ outcome: "delivered" });
    }),
  );
});

layer(nodeFilePlatformLayer)("intercom session tool issues", (it) => {
  it.effect("words every refusal and uncertainty as a short issue", () =>
    Effect.sync(() => {
      const codes: ReadonlyArray<ToolRefusalCode> = [
        "session_unavailable",
        "session_receive_disabled",
        "session_not_found",
        "session_ambiguous",
        "session_unreachable",
        "session_message_too_long",
      ];
      const session = { sessionId: "session-b", name: "web work", cwd: "/work/web" };
      const issues = [
        ...codes.flatMap((code) =>
          [SESSION_TOOL.send, SESSION_TOOL.read].map((tool) =>
            refusalIssue({
              contract: "pi-intercom/session",
              version: 1,
              tool,
              outcome: "refused",
              code,
              to: "session-b",
              session,
            }),
          ),
        ),
        uncertainIssue({
          contract: "pi-intercom/session",
          version: 1,
          tool: SESSION_TOOL.send,
          outcome: "uncertain",
          session,
          reason: "timeout",
        }),
      ];
      expect(issues.flatMap(({ message }) => issueMessageStyleProblems(message))).toEqual([]);
    }),
  );
});
