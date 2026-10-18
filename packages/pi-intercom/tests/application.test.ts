import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { registerIntercomApplication } from "../src/application.ts";
import { hostIntercomInbound } from "../src/boundary/host-inbound.ts";
import { INTERCOM_MESSAGE_TYPE } from "../src/delivery.ts";
import { deliverMessage, describeSession, readLastMessage } from "../src/transport/client.ts";
import { assistantEntry, failureOf, harness, onlyRecord } from "./support/session-harness.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const peerMessage = {
  from: { sessionId: "peer", cwd: "/peer" },
  messageId: "message-1",
  text: "Hello from another session.",
};

layer(nodeFilePlatformLayer)("intercom application", (it) => {
  it.effect("registers a session at start and removes its record at shutdown", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();

      const [record] = yield* h.records;
      expect(yield* h.records).toHaveLength(1);
      expect(record).toMatchObject({
        version: 1,
        pid: process.pid,
        sessionId: "session-1",
        name: "first name",
        cwd: h.base,
      });
      expect(record?.instance).toMatch(/^[0-9a-f]{32}$/);
      expect(record?.token).toMatch(/^[0-9a-f]{64}$/);
      expect(record?.socket.startsWith(h.agentDirectory)).toBe(true);

      yield* h.shutdown();
      expect(yield* h.records).toEqual([]);
    }),
  );

  it.effect("rewrites the record when the session name changes", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "rpc" });
      yield* h.start();
      const [before] = yield* h.records;

      yield* h.rename("second name");
      const [renamed] = yield* h.records;
      yield* h.rename(undefined);
      const [cleared] = yield* h.records;

      expect(renamed).toEqual({ ...before, name: "second name" });
      expect(cleared?.name).toBeUndefined();
      expect(cleared?.instance).toBe(before?.instance);
    }),
  );

  it.effect("leaves no record when shutdown races a rename", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();

      yield* Effect.all([h.rename("racing name"), h.shutdown()], { concurrency: "unbounded" });

      expect(yield* h.records).toEqual([]);
    }),
  );

  it.effect("replaces the record when the session is replaced", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const [first] = yield* h.records;

      yield* h.replace("session-2");
      const records = yield* h.records;

      expect(records).toHaveLength(1);
      expect(records[0]?.sessionId).toBe("session-2");
      expect(records[0]?.instance).not.toBe(first?.instance);
      expect(records[0]?.token).not.toBe(first?.token);
    }),
  );

  it.effect("uses a private fallback socket directory for long paths and removes it", () =>
    Effect.gen(function* () {
      const h = yield* harness({ longAgentDirectory: true });
      yield* h.start();
      const [record] = yield* h.records;
      const directory = record?.socket.slice(0, record.socket.lastIndexOf("/")) ?? "";

      expect(directory.startsWith(`${h.fallbackRoot}/pi-intercom-`)).toBe(true);
      expect(Buffer.byteLength(record?.socket ?? "")).toBeLessThanOrEqual(100);
      expect(yield* h.fs.exists(directory)).toBe(true);
      if (record) expect((yield* describeSession(record)).sessionId).toBe("session-1");

      yield* h.shutdown();
      expect(yield* h.fs.exists(directory)).toBe(false);
      expect(yield* h.records).toEqual([]);
    }),
  );

  it.effect("answers peers over its socket until shutdown", () =>
    Effect.gen(function* () {
      const first = yield* harness();
      yield* first.start();
      const record = yield* onlyRecord(first.records);
      const second = yield* harness({ sessionId: "session-2" });
      yield* second.start();
      const other = yield* onlyRecord(second.records);
      first.setBranch([assistantEntry("The latest reply.")]);

      expect(yield* describeSession(record)).toEqual({
        sessionId: "session-1",
        name: "first name",
        cwd: first.base,
        state: "idle",
      });
      yield* first.rename("renamed");
      first.setIdle(false);
      expect(yield* describeSession(record)).toMatchObject({ name: "renamed", state: "busy" });
      expect(yield* readLastMessage(record)).toEqual({
        text: "The latest reply.",
        truncated: false,
        state: "busy",
      });
      expect((yield* readLastMessage(other)).text).toBeUndefined();
      expect(yield* deliverMessage(record, peerMessage)).toBe("queued");
      expect(first.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: INTERCOM_MESSAGE_TYPE }),
        { triggerTurn: false },
      );
      expect(
        yield* failureOf(describeSession({ socket: record.socket, token: other.token })),
      ).toMatchObject({ reason: "unauthorized" });

      yield* first.shutdown();

      expect(yield* first.fs.exists(record.socket)).toBe(false);
      expect(yield* first.records).toEqual([]);
      expect(yield* failureOf(describeSession(record))).toMatchObject({ reason: "unreachable" });
      expect((yield* describeSession(other)).sessionId).toBe("session-2");
    }),
  );

  it.effect("moves to a new socket and token when the session is replaced", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const first = yield* onlyRecord(h.records);

      yield* h.replace("session-2");
      const next = yield* onlyRecord(h.records);

      expect(yield* h.fs.exists(first.socket)).toBe(false);
      expect((yield* describeSession(next)).sessionId).toBe("session-2");
      expect(
        yield* failureOf(describeSession({ socket: next.socket, token: first.token })),
      ).toMatchObject({ reason: "unauthorized" });
    }),
  );

  it.effect("registers nothing outside the TUI and RPC modes", () =>
    Effect.gen(function* () {
      for (const mode of ["print", "json"] as const) {
        const h = yield* harness({ mode });
        yield* h.start();
        yield* h.rename("ignored");
        expect(yield* h.fs.exists(`${h.agentDirectory}/intercom`)).toBe(false);
        expect(h.host.tools.size).toBe(0);
        expect(h.notify).not.toHaveBeenCalled();
      }
    }),
  );

  it.effect("registers nothing in a subagent child process", () =>
    Effect.sync(() => {
      vi.stubEnv("PI_SUBAGENT_CHILD", "1");
      const host = recordingExtensionHost();
      registerIntercomApplication(host.pi);
      expect(host.messageRenderers.size).toBe(0);

      expect(host.handlers.has("session_start")).toBe(false);
      expect(host.handlers.has("session_info_changed")).toBe(false);
      expect(host.handlers.has("session_shutdown")).toBe(false);
      expect(host.tools.size).toBe(0);
      expect(host.commands.size).toBe(0);
    }),
  );
});

layer(nodeFilePlatformLayer)("intercom host inbound", (it) => {
  it.effect("refuses every request once its runtime is retired", () =>
    Effect.gen(function* () {
      let current = true;
      const inbound = hostIntercomInbound(
        extensionContextFixture({ cwd: "/project", sessionManager: { getSessionId: () => "s" } }),
        () => current,
        {
          deliver: (_message, _now, isCurrent) =>
            isCurrent() ? Result.succeed("woken") : Result.fail("session_unavailable"),
        },
      );
      expect((yield* inbound.describe).sessionId).toBe("s");

      current = false;

      const refused = { code: "session_unavailable" };
      expect(yield* failureOf(inbound.describe)).toMatchObject(refused);
      expect(yield* failureOf(inbound.readLast)).toMatchObject(refused);
      expect(yield* failureOf(inbound.deliver(peerMessage))).toMatchObject(refused);
    }),
  );
});
