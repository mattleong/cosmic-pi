import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { expect } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { currentProcessIdentity, synchronousRandomHex } from "pi-cosmic-core";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { createServer, type Socket } from "node:net";
import { vi } from "vitest";
import { registerIntercomApplication } from "../../src/application.ts";
import { hostIntercomInbound } from "../../src/boundary/host-inbound.ts";
import { registerIntercomDelivery } from "../../src/delivery.ts";
import { intercomLayer } from "../../src/layer.ts";
import { SessionRecordFromJson, sessionRecord } from "../../src/registry/schema.ts";
import { IntercomSession, type IntercomSessionInput } from "../../src/session/service.ts";
import type { SessionToolArgs } from "../../src/tools/contract.ts";

export const assistantEntry = (text: string): SessionEntry => ({
  type: "message",
  id: "assistant-entry",
  parentId: null,
  timestamp: "",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  },
});

export const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.result(effect), (result) =>
    Result.isFailure(result) ? result.failure : undefined,
  );

export const onlyRecord = <A, E, R>(records: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.gen(function* () {
    const all = yield* records;
    expect(all).toHaveLength(1);
    return yield* Effect.fromNullishOr(all[0]);
  });

/**
 * A registry record of a live owner whose socket nobody answers, or `socket` when given, in the
 * registry of the sessions sharing `where.base`.
 */
export const writeForeignRecord = (
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

/** A listener at `socket` that takes connections and never answers them. */
export const hangingListener = (socket: string) =>
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

/** Where sessions of one simulated OS user keep their registry. */
export interface SharedAgentDirectory {
  readonly base: string;
  readonly agentDirectory: string;
  readonly fallbackRoot: string;
}

export const sharedAgentDirectory = (options: { readonly long?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    // Short enough for a socket path under the agent directory unless asked otherwise.
    const base = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "intercom-app-" });
    const agentDirectory = paths.join(base, options.long ? Fn.pipe("a", Str.repeat(80)) : "agent");
    const fallbackRoot = paths.join(base, "tmp");
    yield* fs.makeDirectory(fallbackRoot, { recursive: true });
    return { base, agentDirectory, fallbackRoot } satisfies SharedAgentDirectory;
  });

export interface HarnessOptions {
  readonly mode?: ExtensionContext["mode"];
  readonly longAgentDirectory?: boolean;
  readonly sessionId?: string;
  readonly sessionName?: string | undefined;
  /** Shares another harness's registry, as two sessions of one user do. */
  readonly shared?: SharedAgentDirectory;
}

/** One Pi session with the intercom extension loaded, driven through recorded host events. */
export const harness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const shared =
      options.shared ??
      (yield* sharedAgentDirectory(options.longAgentDirectory ? { long: true } : {}));
    const { base, agentDirectory, fallbackRoot } = shared;
    yield* Effect.sync(() => {
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
      vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
    });
    const sessions = paths.join(agentDirectory, "intercom", "sessions");

    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const host = recordingExtensionHost({}, { sendMessage });
    let sessionName = "sessionName" in options ? options.sessionName : "first name";
    let sessionId = options.sessionId ?? "session-1";
    let idle = true;
    let branch: ReadonlyArray<SessionEntry> = [];
    const notify = vi.fn();
    const ctx = extensionContextFixture({
      cwd: base,
      mode: options.mode ?? "tui",
      isIdle: () => idle,
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionName: () => sessionName,
        getBranch: () => [...branch],
      },
      ui: { notify },
    });
    registerIntercomApplication(host.pi, {
      fallbackSocketRoot: fallbackRoot,
      loadSettings: () => Promise.resolve(),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => host.emit("session_shutdown", ctx)));

    const records = Effect.gen(function* () {
      const files = yield* fs
        .readDirectory(sessions)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
      return yield* Effect.forEach(
        Arr.filter(files, (file) => Fn.pipe(file, Str.endsWith(".json"))),
        (file) =>
          Effect.flatMap(fs.readFileString(paths.join(sessions, file)), (source) =>
            Schema.decodeEffect(SessionRecordFromJson)(source),
          ),
      );
    });

    const tool = (name: string) => {
      const definition = host.tools.get(name);
      if (!definition) throw new Error(`${name} isn't registered.`);
      return definition;
    };
    const callTool = (name: string, args: SessionToolArgs) =>
      Effect.promise(
        (): Promise<AgentToolResult<unknown>> =>
          tool(name).execute("call-1", args, undefined, undefined, ctx),
      );
    const command = (args: string) =>
      Effect.gen(function* () {
        const registered = yield* Effect.fromNullishOr(host.commands.get("intercom"));
        yield* Effect.promise(() => Promise.resolve(registered.handler(args, ctx)));
      });

    return {
      fs,
      host,
      ctx,
      notify,
      sendMessage,
      base,
      agentDirectory,
      fallbackRoot,
      shared,
      sessions,
      records,
      tool,
      callTool,
      command,
      setIdle: (next: boolean) => {
        idle = next;
      },
      setBranch: (next: ReadonlyArray<SessionEntry>) => {
        branch = next;
      },
      start: () =>
        Effect.promise(() =>
          host.emit("session_start", ctx, { type: "session_start", reason: "startup" }),
        ),
      rename: (name: string | undefined) => {
        sessionName = name;
        return Effect.promise(() =>
          host.emit("session_info_changed", ctx, { type: "session_info_changed", name }),
        );
      },
      replace: (nextSessionId: string) => {
        sessionId = nextSessionId;
        return Effect.promise(() =>
          host.emit("session_start", ctx, { type: "session_start", reason: "new" }),
        );
      },
      shutdown: () => Effect.promise(() => host.emit("session_shutdown", ctx)),
    };
  });

/**
 * One session runtime built directly from its layer, with real delivery into a recorded host, so
 * a test can run tool operations against its context. Its startup sweep may still be running.
 * `PI_CODING_AGENT_DIR` must name the shared agent directory.
 */
export const startSessionRuntime = (
  session: IntercomSessionInput,
  replyText: string,
  fallbackRoot: string,
) =>
  Effect.gen(function* () {
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const host = recordingExtensionHost({}, { sendMessage });
    const delivery = registerIntercomDelivery(host.pi, { isIdle: () => true, later: () => {} });
    const ctx = extensionContextFixture({
      cwd: session.cwd,
      sessionManager: {
        getSessionId: () => session.sessionId,
        getSessionName: () => session.name,
        getBranch: () => [assistantEntry(replyText)],
      },
    });
    const context = yield* Layer.build(
      intercomLayer(
        session,
        hostIntercomInbound(ctx, () => true, delivery),
        { fallbackRoot },
      ),
    );
    const { record, swept } = yield* Effect.provide(Effect.service(IntercomSession), context);
    /** Starts closing the session, as Pi's shutdown of a replaced session does. */
    const close = Effect.promise(() => host.emit("session_shutdown", ctx));
    return { context, delivery, sendMessage, record: yield* record, swept, close };
  });

/**
 * A session runtime as `startSessionRuntime` builds it, once its startup sweep has ended, so the
 * sweep never meets records a test writes afterwards.
 */
export const sessionRuntime = (
  session: IntercomSessionInput,
  replyText: string,
  fallbackRoot: string,
) => Effect.tap(startSessionRuntime(session, replyText, fallbackRoot), ({ swept }) => swept);
