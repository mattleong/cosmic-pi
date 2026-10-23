import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import {
  currentProcessIdentity,
  nodeFilePlatformLayer,
  synchronousRandomHex,
} from "pi-cosmic-core";
import { connect, createServer, type Socket } from "node:net";
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
import { OwnerLiveness } from "../src/registry/store.ts";
import { DESCRIBE_DEADLINE } from "../src/transport/client.ts";
import { IntercomRefused, MAX_MESSAGE_CHARS } from "../src/transport/protocol.ts";
import { IntercomInbound, serveIntercom } from "../src/transport/server.ts";
import {
  listSessions,
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

/** A listener at `socket` that takes connections and never answers them. */
const hangingListener = (socket: string) =>
  Effect.gen(function* () {
    const peers = new Set<Socket>();
    const waiters = new Set<{ readonly total: number; readonly wake: () => void }>();
    yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const server = createServer((peer) => {
          peer.on("error", () => undefined);
          peers.add(peer);
          for (const waiter of waiters)
            if (peers.size >= waiter.total) {
              waiters.delete(waiter);
              waiter.wake();
            }
        });
        server.listen(socket, () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          for (const peer of peers) peer.destroy();
        }),
    );
    return {
      /** Waits until `total` connections have arrived in all. */
      arrived: (total: number) =>
        Effect.callback<void>((resume) => {
          if (peers.size >= total) return resume(Effect.void);
          const waiter = { total, wake: () => resume(Effect.void) };
          waiters.add(waiter);
          return Effect.sync(() => void waiters.delete(waiter));
        }),
    };
  });

const unnamedSession = (sessionId: string) => ({ sessionId, name: undefined, cwd: "/project" });

layer(nodeFilePlatformLayer)("intercom session tools", (it) => {
  it.effect("lists other live sessions, marking silent ones and duplicate ids", () =>
    Effect.gen(function* () {
      const { shared, a } = yield* twoSessions;
      yield* writeForeignRecord(a, "silent");
      yield* writeForeignRecord(a, "twin");
      yield* writeForeignRecord(a, "twin");
      yield* writeForeignRecord(a, "dead", { pid: 99_999_999 });

      const twin = yield* harness({ shared, sessionId: "live-twin", sessionName: "twin one" });
      yield* twin.start();
      const other = yield* harness({ shared, sessionId: "live-twin", sessionName: "twin two" });
      yield* other.start();

      const result = yield* a.callTool(SESSION_TOOL.list, {});
      const details = detailsOf(result);

      expect(result.structuredContent).toEqual(details);
      if (details.tool !== SESSION_TOOL.list) throw new Error("Expected a listing.");
      // Only sessions that answered can be addressed, so only they count as duplicates.
      expect(
        details.sessions.map(({ sessionId, name, state, duplicate }) => ({
          sessionId,
          name,
          state,
          duplicate,
        })),
      ).toEqual([
        { sessionId: "silent", name: undefined, state: "unreachable", duplicate: false },
        { sessionId: "twin", name: undefined, state: "unreachable", duplicate: false },
        { sessionId: "twin", name: undefined, state: "unreachable", duplicate: false },
        { sessionId: "live-twin", name: "twin one", state: "idle", duplicate: true },
        { sessionId: "live-twin", name: "twin two", state: "idle", duplicate: true },
        { sessionId: "session-b", name: "web work", state: "idle", duplicate: false },
      ]);
    }),
  );

  it.effect("addresses the one session that answers among records sharing its id", () =>
    Effect.gen(function* () {
      const { shared, a, b } = yield* twoSessions;
      // A suspended Pi with the same session id left a record nothing answers for.
      yield* writeForeignRecord(a, "session-b");
      b.setBranch([assistantEntry("The web tests pass.")]);

      const delivered = yield* a.callTool(SESSION_TOOL.send, { to: "session-b", message: "Hi." });
      const read = yield* a.callTool(SESSION_TOOL.read, { to: "session-b" });

      expect(detailsOf(delivered)).toMatchObject({ outcome: "delivered", disposition: "woken" });
      expect(b.sendMessage).toHaveBeenCalledTimes(1);
      expect(detailsOf(read)).toMatchObject({ text: "The web tests pass." });

      // A second session that answers under the same id makes it ambiguous.
      const twin = yield* harness({ shared, sessionId: "session-b", sessionName: "web twin" });
      yield* twin.start();
      const refused = yield* a.callTool(SESSION_TOOL.send, { to: "session-b", message: "Hi." });
      expect(detailsOf(refused)).toMatchObject({ outcome: "refused", code: "session_ambiguous" });
      expect(b.sendMessage).toHaveBeenCalledTimes(1);
      expect(twin.sendMessage).not.toHaveBeenCalled();
    }),
  );

  it.effect("tells sessions that don't answer in time from ones nothing answers for", () =>
    Effect.gen(function* () {
      const paths = yield* Path.Path;
      const shared = yield* sharedAgentDirectory();
      yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", shared.agentDirectory));
      const a = yield* sessionRuntime(unnamedSession("session-a"), "From a.", shared.fallbackRoot);
      const registry = {
        base: shared.base,
        sessions: paths.join(shared.agentDirectory, "intercom", "sessions"),
      };
      const socket = paths.join(shared.base, "stuck.sock");
      const stuck = yield* hangingListener(socket);
      yield* writeForeignRecord(registry, "stuck", { socket });
      yield* writeForeignRecord(registry, "stuck", { socket });
      yield* writeForeignRecord(registry, "gone");
      // Each call's deadline runs on the test clock, moved once every describe has connected.
      const pastDeadline = <X, E>(
        effect: Effect.Effect<X, E, Layer.Success<ReturnType<typeof intercomLayer>>>,
        connections: number,
      ) =>
        Effect.gen(function* () {
          const fiber = yield* effect.pipe(
            Effect.provideService(OwnerLiveness, () => Effect.succeed("alive")),
            Effect.provide(a.context),
            Effect.result,
            Effect.forkChild,
          );
          yield* stuck.arrived(connections);
          yield* TestClock.adjust(DESCRIBE_DEADLINE);
          return yield* Fiber.join(fiber);
        });

      const listed = yield* pastDeadline(listSessions(), 2);
      const sent = yield* pastDeadline(sendToSession("stuck", "Hello."), 4);

      expect(
        Result.getOrThrow(listed).sessions.map(({ sessionId, state, duplicate }) => ({
          sessionId,
          state,
          duplicate,
        })),
      ).toEqual([
        { sessionId: "gone", state: "unreachable", duplicate: false },
        { sessionId: "stuck", state: "unresponsive", duplicate: false },
        { sessionId: "stuck", state: "unresponsive", duplicate: false },
      ]);
      expect(Result.isFailure(sent) && sent.failure).toMatchObject({
        code: "session_unresponsive",
      });
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
          Effect.provideService(OwnerLiveness, ({ pid }) =>
            Effect.sync(() => {
              asked.push(pid);
              return pid === deadPid ? "dead" : "alive";
            }),
          ),
          Effect.provide(a.context),
        );

      const listed = yield* fromA(listSessions());
      expect(listed.sessions.map(({ sessionId, state }) => ({ sessionId, state }))).toEqual([
        { sessionId: "session-b", state: "idle" },
        { sessionId: "silent", state: "unreachable" },
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
      expect(options).toMatchObject({ triggerTurn: true });
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
      expect(b.sendMessage.mock.calls[1]?.[1]).toMatchObject({ triggerTurn: false });
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
      // Twins that both stay silent can't be addressed either.
      expect(yield* refusal(SESSION_TOOL.read, "twin")).toBe("session_unreachable");
      expect(yield* refusal(SESSION_TOOL.send, "silent")).toBe("session_unreachable");
      expect(yield* refusal(SESSION_TOOL.read, "silent")).toBe("session_unreachable");

      yield* b.command("receive off");
      expect(yield* refusal(SESSION_TOOL.send, "session-b")).toBe("session_receive_disabled");
      yield* b.command("receive on");
      const delivered = yield* a.callTool(SESSION_TOOL.send, { to: "session-b", message: "Hi." });
      expect(detailsOf(delivered)).toMatchObject({ outcome: "delivered" });
    }),
  );

  it.effect("tells a session that refuses from one nothing answers for", () =>
    Effect.gen(function* () {
      const { a } = yield* twoSessions;
      const paths = yield* Path.Path;
      const socket = paths.join(a.shared.base, "reloading.sock");
      const token = synchronousRandomHex(32);
      const unavailable = Effect.fail(new IntercomRefused({ code: "session_unavailable" }));
      yield* serveIntercom({ socket, token }).pipe(
        Effect.provideService(IntercomInbound, {
          describe: unavailable,
          deliver: () => unavailable,
          readLast: unavailable,
        }),
      );
      // Silent twins on both sides of the refusing record, whatever order the listing takes.
      for (let index = 0; index < 3; index += 1) yield* writeForeignRecord(a, "reloading");
      yield* writeForeignRecord(a, "reloading", { socket, token });
      for (let index = 0; index < 3; index += 1) yield* writeForeignRecord(a, "reloading");

      const listed = detailsOf(yield* a.callTool(SESSION_TOOL.list, {}));
      const sent = detailsOf(
        yield* a.callTool(SESSION_TOOL.send, { to: "reloading", message: "Hi." }),
      );
      const read = detailsOf(yield* a.callTool(SESSION_TOOL.read, { to: "reloading" }));

      if (listed.tool !== SESSION_TOOL.list) throw new Error("Expected a listing.");
      expect(
        listed.sessions
          .filter(({ sessionId }) => sessionId === "reloading")
          .map(({ state }) => state)
          .toSorted(),
      ).toEqual(["unavailable", ...Array.from({ length: 6 }, () => "unreachable")]);
      expect(sent).toMatchObject({ outcome: "refused", code: "session_unavailable" });
      expect(read).toMatchObject({ outcome: "refused", code: "session_unavailable" });
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

  it.effect("prepares arguments leniently and refuses an overlong message without cutting it", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoSessions;
      const prepare = (name: string, args: Readonly<Record<string, string>>) =>
        a.tool(name).prepareArguments?.(args);
      const overlong = { to: "session-b", message: "x".repeat(MAX_MESSAGE_CHARS + 1) };
      const longest = { to: "session-b", message: "y".repeat(MAX_MESSAGE_CHARS) };

      // Preparation leaves the length to the tool, whose refusal tells the model to shorten it.
      expect(prepare(SESSION_TOOL.send, overlong)).toEqual(overlong);
      const refused = yield* a.callTool(SESSION_TOOL.send, overlong);
      expect(detailsOf(refused)).toMatchObject({ code: "session_message_too_long" });
      expect(b.sendMessage).not.toHaveBeenCalled();
      const delivered = yield* a.callTool(SESSION_TOOL.send, longest);
      expect(detailsOf(delivered)).toMatchObject({ outcome: "delivered" });
      expect(b.sendMessage.mock.calls[0]?.[0].content).toContain(longest.message);

      expect(() => prepare(SESSION_TOOL.send, { sessionId: "session-b", message: "Hi." })).toThrow(
        /"sessionId" \(use "to"\)/,
      );
      expect(() => prepare(SESSION_TOOL.read, { to: " " })).toThrow(/invalid_arguments/);
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
        "session_unresponsive",
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
