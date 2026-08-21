// Node/MCP Promise behavior is characterized at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType, runtimeTypeName } from "pi-cosmic-core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeSupervisorChannel,
  PeerSendNotAttemptedError,
  type SupervisorChannelHandle,
} from "../src/boundary/supervisor-channel.ts";
import {
  authenticateSupervisorServerPayload,
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorAuthTokenSchema,
  SupervisorRunIdSchema,
  type SupervisorServerPayload,
} from "../src/supervisor/protocol.ts";

type JsonRpcValue = string | number | boolean | null | JsonRpcValue[] | JsonRpcObject;
interface JsonRpcObject {
  readonly [key: string]: JsonRpcValue;
}

const temporaryDirectories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

const wait = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

const withTimeout = async <A>(promise: Promise<A>, millis = 5_000): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("test operation timed out")), millis),
    ),
  ]);

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.stdin.destroy();
    child.kill("SIGKILL");
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface OpenTestChannel {
  readonly handle: SupervisorChannelHandle;
  readonly scope: Scope.Closeable;
  readonly agentDirectory: string;
  readonly projectDirectory: string;
}

const openChannel = async (runId = "agent-supervisor-test"): Promise<OpenTestChannel> => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-supervisor-"));
  temporaryDirectories.push(root);
  const agentDirectory = join(root, "agent-home");
  const projectDirectory = join(root, "project");
  await Promise.all([
    mkdir(agentDirectory, { mode: 0o700 }),
    mkdir(projectDirectory, { mode: 0o700 }),
  ]);
  await writeFile(join(projectDirectory, "marker.txt"), "project-only\n", "utf8");
  const scope = await Effect.runPromise(Scope.make());
  const handle = await Effect.runPromise(
    makeSupervisorChannel({ agentDirectory })
      .open({ runId })
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return { handle, scope, agentDirectory, projectDirectory };
};

class RpcClient {
  readonly messages: JsonRpcValue[] = [];
  readonly #pending = new Map<string, (value: JsonRpcValue) => void>();
  readonly #waiters: Array<{
    readonly predicate: (value: JsonRpcValue) => boolean;
    readonly resolve: (value: JsonRpcValue) => void;
  }> = [];
  #buffer = "";
  readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf8");
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        // SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
        const value = JSON.parse(line) as JsonRpcValue;
        this.messages.push(value);
        if (value && hasObjectRuntimeType(value) && "id" in value) {
          const key = `${runtimeTypeName(value.id)}:${String(value.id)}`;
          const resolve = this.#pending.get(key);
          if (resolve) {
            this.#pending.delete(key);
            resolve(value);
          }
        }
        for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
          const waiter = this.#waiters[index];
          if (!waiter?.predicate(value)) continue;
          this.#waiters.splice(index, 1);
          waiter.resolve(value);
        }
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  send<ValueInput>(value: ValueInput): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request<Request extends JsonRpcObject & { readonly id: string | number }>(value: Request) {
    const key = `${runtimeTypeName(value.id)}:${String(value.id)}`;
    const response = new Promise<JsonRpcValue>((resolve) => this.#pending.set(key, resolve));
    this.send(value);
    return withTimeout(response);
  }

  next(predicate: (value: JsonRpcValue) => boolean) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return withTimeout(new Promise((resolve) => this.#waiters.push({ predicate, resolve })));
  }
}

const spawnHelper = (handle: SupervisorChannelHandle) => {
  const child = spawn(
    process.execPath,
    [handle.metadata.helperPath, "--config", handle.metadata.connectionConfigPath],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  return { child, rpc: new RpcClient(child) };
};

const initialize = async (rpc: RpcClient) => {
  const initialized = await rpc.request({
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  expect(initialized).toMatchObject({
    id: "initialize",
    result: { protocolVersion: "2025-06-18" },
  });
  rpc.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
};

const toolCall = (rpc: RpcClient, id: string | number, name: string, args: JsonRpcObject) =>
  rpc.request({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

const takeEvent = (handle: SupervisorChannelHandle) =>
  withTimeout(Effect.runPromise(Queue.take(handle.events)));

const waitForExit = (child: ChildProcessWithoutNullStreams) =>
  withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    ),
  );

interface RawChannelClient {
  readonly socket: Socket;
  readonly send: (value: JsonRpcObject) => void;
  readonly request: <Request extends JsonRpcObject & { readonly id: string }>(
    value: Request,
  ) => Promise<JsonRpcValue>;
  readonly next: (predicate: (value: JsonRpcValue) => boolean) => Promise<JsonRpcValue>;
}

const connectRawChannel = async (handle: SupervisorChannelHandle): Promise<RawChannelClient> => {
  const socket = connect({ host: handle.metadata.host, port: handle.metadata.port });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
  );
  let buffer = "";
  const messages: JsonRpcValue[] = [];
  const pending = new Map<string, (value: JsonRpcValue) => void>();
  const waiters: Array<{
    readonly predicate: (value: JsonRpcValue) => boolean;
    readonly resolve: (value: JsonRpcValue) => void;
  }> = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      // SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
      const value = JSON.parse(buffer.slice(0, newline)) as JsonRpcValue;
      buffer = buffer.slice(newline + 1);
      messages.push(value);
      if (value && hasObjectRuntimeType(value) && "id" in value && Predicate.isString(value.id)) {
        pending.get(value.id)?.(value);
        pending.delete(value.id);
      }
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (!waiter?.predicate(value)) continue;
        waiters.splice(index, 1);
        waiter.resolve(value);
      }
      newline = buffer.indexOf("\n");
    }
  });
  const send = (value: JsonRpcObject) => {
    socket.write(`${JSON.stringify(value)}\n`);
  };
  const request = <Request extends JsonRpcObject & { readonly id: string }>(value: Request) => {
    const response = new Promise<JsonRpcValue>((resolve) => pending.set(value.id, resolve));
    send(value);
    return withTimeout(response);
  };
  const next = (predicate: (value: JsonRpcValue) => boolean) => {
    const existing = messages.find(predicate);
    return existing
      ? Promise.resolve(existing)
      : withTimeout(new Promise<JsonRpcValue>((resolve) => waiters.push({ predicate, resolve })));
  };
  return { socket, send, request, next };
};

// SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
const connectionConfig = async (handle: SupervisorChannelHandle) =>
  JSON.parse(await readFile(handle.metadata.connectionConfigPath, "utf8")) as {
    readonly version: 1;
    readonly runId: string;
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly token: string;
  };

describe("private supervisor channel", () => {
  it("discriminates pre-write peer send failures from write-callback failures", () => {
    const unsent = new PeerSendNotAttemptedError({ reason: "oversized" });
    expect(unsent._tag).toBe("PeerSendNotAttemptedError");
    expect(unsent.reason).toBe("oversized");
    expect(unsent instanceof PeerSendNotAttemptedError).toBe(true);
    // A write-callback failure may race bytes already handed to the OS socket, so it is
    // deliberately NOT classified as unsent.
    expect(new Error("write after end") instanceof PeerSendNotAttemptedError).toBe(false);
  });

  it("constructs authenticated server messages with reserved fields authoritative", () => {
    expect(Option.isSome(SupervisorAuthTokenSchema.makeOption("a".repeat(64)))).toBe(true);
    expect(Option.isNone(SupervisorAuthTokenSchema.makeOption("short"))).toBe(true);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const authenticated = authenticateSupervisorServerPayload(
      {
        version: SUPERVISOR_CHANNEL_VERSION,
        runId: SupervisorRunIdSchema.make("authoritative-run"),
        token: SupervisorAuthTokenSchema.make("a".repeat(64)),
      },
      {
        type: "closed",
        version: 999,
        runId: "forged-run",
        token: "b".repeat(64),
      } as SupervisorServerPayload,
    );
    expect(authenticated).toMatchObject({
      version: SUPERVISOR_CHANNEL_VERSION,
      runId: "authoritative-run",
      token: "a".repeat(64),
      type: "closed",
    });
  });

  it("rejects invalid run identities, relative state roots, and symlink state roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-supervisor-paths-"));
    temporaryDirectories.push(root);
    const agentDirectory = join(root, "agent-home");
    await mkdir(agentDirectory, { mode: 0o700 });
    const scope = await Effect.runPromise(Scope.make());

    await expect(
      Effect.runPromise(
        makeSupervisorChannel({ agentDirectory })
          .open({ runId: "../invalid" })
          .pipe(Effect.provideService(Scope.Scope, scope)),
      ),
    ).rejects.toMatchObject({ code: "invalid_run_id" });
    await expect(
      Effect.runPromise(
        makeSupervisorChannel({ agentDirectory: "relative-agent-home" })
          .open({ runId: "agent-path-test" })
          .pipe(Effect.provideService(Scope.Scope, scope)),
      ),
    ).rejects.toMatchObject({ code: "channel_open_failed" });

    if (process.platform !== "win32") {
      const linkedAgentDirectory = join(root, "linked-agent-home");
      await symlink(agentDirectory, linkedAgentDirectory, "dir");
      await expect(
        Effect.runPromise(
          makeSupervisorChannel({ agentDirectory: linkedAgentDirectory })
            .open({ runId: "agent-path-test" })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        ),
      ).rejects.toMatchObject({ code: "channel_open_failed" });
    }
    expect(await readdir(agentDirectory)).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("closes a late successful acquisition after open is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-supervisor-late-open-"));
    temporaryDirectories.push(root);
    const agentDirectory = join(root, "agent-home");
    await mkdir(agentDirectory, { mode: 0o700 });
    const scope = await Effect.runPromise(Scope.make());
    let entered!: () => void;
    const acquisitionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let complete!: () => void;
    const acquisitionGate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let metadata: SupervisorChannelHandle["metadata"] | undefined;
    const channel = makeSupervisorChannel({
      agentDirectory,
      beforeAcquireComplete: (acquired) => {
        metadata = acquired;
        entered();
        return acquisitionGate;
      },
    });
    const abort = new AbortController();
    const opening = Effect.runPromise(
      channel
        .open({ runId: "agent-supervisor-late-open" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
      { signal: abort.signal },
    );

    await withTimeout(acquisitionEntered);
    abort.abort();
    await expect(withTimeout(opening)).rejects.toBeDefined();
    const acquired = metadata;
    if (!acquired) throw new Error("late acquisition metadata was not captured");
    expect(await stat(acquired.connectionConfigPath)).toBeDefined();

    complete();
    let cleaned = false;
    for (let attempt = 0; attempt < 100 && !cleaned; attempt += 1) {
      cleaned = await stat(acquired.connectionConfigPath).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      if (!cleaned) await wait(10);
    }
    expect(cleaned).toBe(true);
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: acquired.host, port: acquired.port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    });
    expect(refused).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("spawns the helper and keeps blocked questions concurrent, correlated, cancellable, and epoch-safe", async () => {
    const opened = await openChannel();
    const { handle, scope, projectDirectory } = opened;

    const config = await connectionConfig(handle);
    expect(config).toMatchObject({
      version: 1,
      runId: handle.runId,
      host: "127.0.0.1",
      port: handle.metadata.port,
    });
    expect(config.token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(handle.metadata)).not.toContain(config.token);
    expect(handle.metadata.claudeMcp.mcpServers.pi_subagents_supervisor).toMatchObject({
      type: "stdio",
      command: process.execPath,
      env: {},
    });
    expect(handle.metadata.codexMcp.tomlFragment).toContain(
      "[mcp_servers.pi_subagents_supervisor]",
    );
    expect(handle.metadata.codexMcp.tomlFragment).not.toContain("env =");

    const stateMode = (await stat(handle.metadata.stateDirectory)).mode & 0o777;
    const configMode = (await stat(handle.metadata.connectionConfigPath)).mode & 0o777;
    expect(stateMode).toBe(0o700);
    expect(configMode).toBe(0o600);
    expect(await readdir(projectDirectory)).toEqual(["marker.txt"]);

    const { child, rpc } = spawnHelper(handle);
    await initialize(rpc);
    await Effect.runPromise(handle.awaitReady);
    await Effect.runPromise(handle.setAssignmentEpoch(1));
    const listed = await rpc.request({
      jsonrpc: "2.0",
      id: "list",
      method: "tools/list",
      params: {},
    });
    expect(listed).toMatchObject({
      result: {
        tools: [
          { name: "supervisor_progress" },
          { name: "supervisor_warning" },
          { name: "supervisor_question" },
          { name: "supervisor_submit_report" },
        ],
      },
    });

    const questionResponse = toolCall(rpc, "question-1", "supervisor_question", {
      message: "Which implementation should I use?",
    });
    const question = await takeEvent(handle);
    expect(question).toMatchObject({
      type: "supervisor_contact",
      kind: "question",
      assignmentEpoch: 1,
      message: "Which implementation should I use?",
    });
    if (question.type !== "supervisor_contact") throw new Error("expected question");
    rpc.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "an-unrelated-request" },
    });

    const [ping, progress, report] = await Promise.all([
      rpc.request({ jsonrpc: "2.0", id: "ping-while-blocked", method: "ping", params: {} }),
      toolCall(rpc, "progress-while-blocked", "supervisor_progress", {
        message: "Continuing independent work.",
      }),
      toolCall(rpc, "report-while-blocked", "supervisor_submit_report", {
        delivery_id: "delivery-main",
        report: "Bounded final report.",
      }),
    ]);
    expect(ping).toMatchObject({ id: "ping-while-blocked", result: {} });
    expect(progress).not.toMatchObject({ error: expect.anything() });
    expect(report).toMatchObject({
      result: { content: [{ text: expect.stringContaining("sequence 1") }] },
    });
    // Report acceptance is causally visible before the adapter drains either queued event, even
    // when progress/backpressure is ahead of the report.
    expect(await Effect.runPromise(handle.hasAcceptedReport(1))).toBe(true);
    expect(await Effect.runPromise(handle.acceptedReportForEpoch(1))).toMatchObject({
      runId: handle.runId,
      assignmentEpoch: 1,
      deliveryId: "delivery-main",
      text: "Bounded final report.",
    });
    expect(await Effect.runPromise(handle.hasAcceptedReport(2)).catch(() => false)).toBe(false);
    const concurrentEvents = [
      await takeEvent(handle),
      await takeEvent(handle),
      await takeEvent(handle),
    ];
    expect(concurrentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "supervisor_contact",
          kind: "progress",
          assignmentEpoch: 1,
        }),
        expect.objectContaining({
          type: "report",
          assignmentEpoch: 1,
          sequence: 1,
          deliveryId: "delivery-main",
          text: "Bounded final report.",
        }),
        expect.objectContaining({
          type: "supervisor_question_cancelled",
          assignmentEpoch: 1,
          requestId: question.requestId,
        }),
      ]),
    );

    expect(await questionResponse).toMatchObject({ error: { code: -32800 } });
    await expect(
      Effect.runPromise(handle.reply(question.requestId, "Use the service seam.")),
    ).rejects.toMatchObject({ code: "question_ownership_mismatch" });

    const secondQuestion = await toolCall(rpc, "question-duplicate", "supervisor_question", {
      message: "A second question?",
    });
    expect(secondQuestion).toMatchObject({ error: { code: -32000 } });

    const retry = await toolCall(rpc, "report-retry", "supervisor_submit_report", {
      delivery_id: "delivery-main",
      report: "Bounded final report.",
    });
    expect(retry).toMatchObject({
      result: { content: [{ text: expect.stringContaining("retry accepted; sequence 1") }] },
    });
    const noDuplicateEvent = await Effect.runPromise(Queue.poll(handle.events));
    expect(Option.isNone(noDuplicateEvent)).toBe(true);
    const conflict = await toolCall(rpc, "report-conflict", "supervisor_submit_report", {
      delivery_id: "delivery-main",
      report: "Conflicting report.",
    });
    expect(conflict).toMatchObject({ error: { code: -32000 } });

    await Effect.runPromise(handle.setAssignmentEpoch(2));
    const crossEpochRetry = await toolCall(rpc, "report-cross-epoch", "supervisor_submit_report", {
      delivery_id: "delivery-main",
      report: "Bounded final report.",
    });
    expect(crossEpochRetry).toMatchObject({ error: { code: -32000 } });
    const cancelledQuestion = toolCall(rpc, "question-cancelled", "supervisor_question", {
      message: "Wait for a reply that will be cancelled.",
    });
    const cancellationEvent = await takeEvent(handle);
    expect(cancellationEvent).toMatchObject({
      type: "supervisor_contact",
      kind: "question",
      assignmentEpoch: 2,
    });
    rpc.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "question-cancelled" },
    });
    expect(await cancelledQuestion).toMatchObject({ error: { code: -32800 } });
    expect(await takeEvent(handle)).toMatchObject({
      type: "supervisor_question_cancelled",
      assignmentEpoch: 2,
      requestId: cancellationEvent.type === "supervisor_contact" ? cancellationEvent.requestId : "",
    });
    await Effect.runPromise(handle.setAssignmentEpoch(3));
    if (cancellationEvent.type !== "supervisor_contact") throw new Error("expected question");
    await wait(20);
    await expect(
      Effect.runPromise(handle.reply(cancellationEvent.requestId, "Too late.")),
    ).rejects.toMatchObject({ code: "question_ownership_mismatch" });
    expect(
      await rpc.request({ jsonrpc: "2.0", id: "ping-after-cancel", method: "ping", params: {} }),
    ).toMatchObject({ result: {} });

    const raw = await connectRawChannel(handle);
    await raw.request({
      version: 1,
      runId: handle.runId,
      token: config.token,
      type: "hello",
      id: "raw-hello",
    });
    await raw.request({
      version: 1,
      runId: handle.runId,
      token: config.token,
      type: "progress",
      id: "late-progress",
      assignmentEpoch: 1,
      message: "Late event from assignment one.",
    });
    expect(await takeEvent(handle)).toMatchObject({
      type: "supervisor_contact",
      requestId: "late-progress",
      assignmentEpoch: 1,
      message: "Late event from assignment one.",
    });
    raw.socket.destroy();

    const authenticatedThenForged = await connectRawChannel(handle);
    await authenticatedThenForged.request({
      version: 1,
      runId: handle.runId,
      token: config.token,
      type: "hello",
      id: "auth-then-forge",
    });
    const forgedClosed = new Promise<void>((resolve) =>
      authenticatedThenForged.socket.once("close", resolve),
    );
    authenticatedThenForged.socket.write(
      `${JSON.stringify({
        version: 1,
        runId: handle.runId,
        token: "0".repeat(64),
        type: "progress",
        id: "forged-progress",
        assignmentEpoch: 2,
        message: "Must not be accepted.",
      })}\n`,
    );
    await withTimeout(forgedClosed);
    expect(Option.isNone(await Effect.runPromise(Queue.poll(handle.events)))).toBe(true);

    const many = Array.from({ length: 12 }, (_, index) =>
      toolCall(rpc, `concurrent-${index}`, "supervisor_progress", {
        message: `Concurrent progress ${index}`,
      }),
    );
    const manyResponses = await Promise.all(many);
    expect(manyResponses).toHaveLength(12);
    expect(manyResponses.every((value) => value && hasObjectRuntimeType(value))).toBe(true);
    for (let index = 0; index < 12; index += 1) await takeEvent(handle);
    // Every stdout line observed by the parser was independently valid JSON under concurrency.
    expect(rpc.messages.length).toBeGreaterThanOrEqual(20);

    const childExit = waitForExit(child);
    await Effect.runPromise(handle.close);
    expect(await childExit).toMatchObject({ signal: null });
    expect(await readdir(projectDirectory)).toEqual(["marker.txt"]);
    await expect(stat(handle.metadata.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }, 20_000);

  it("waits for a delayed live-peer epoch acknowledgement before advancing", async () => {
    const opened = await openChannel("agent-supervisor-delayed-ack");
    const { handle, scope } = opened;
    const config = await connectionConfig(handle);
    const raw = await connectRawChannel(handle);
    await raw.request({
      version: 1,
      runId: handle.runId,
      token: config.token,
      type: "hello",
      id: "delayed-hello",
    });
    await Effect.runPromise(handle.awaitReady);
    let settled = false;
    const setting = Effect.runPromise(handle.setAssignmentEpoch(1)).finally(() => {
      settled = true;
    });
    const update = await raw.next((value) =>
      Boolean(
        value &&
        hasObjectRuntimeType(value) &&
        "type" in value &&
        value.type === "assignment_epoch",
      ),
    );
    await wait(50);
    expect(settled).toBe(false);
    if (!update || !hasObjectRuntimeType(update) || !("id" in update))
      throw new Error("missing assignment update");
    raw.send({
      version: 1,
      runId: handle.runId,
      token: config.token,
      type: "assignment_epoch_ack",
      id: update.id,
      assignmentEpoch: 1,
    });
    await setting;
    raw.socket.destroy();
    await Effect.runPromise(handle.close);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("fails epoch advancement immediately when every acknowledging helper disconnects", async () => {
    const { handle, scope } = await openChannel("agent-supervisor-epoch-disconnect");
    const config = await connectionConfig(handle);
    const raw = await connectRawChannel(handle);
    await raw.request({
      version: 1,
      runId: handle.runId,
      token: config.token,
      type: "hello",
      id: "epoch-disconnect-hello",
    });
    await Effect.runPromise(handle.awaitReady);
    const setting = Effect.runPromise(handle.setAssignmentEpoch(1));
    await raw.next((value) =>
      Boolean(
        value &&
        hasObjectRuntimeType(value) &&
        "type" in value &&
        value.type === "assignment_epoch",
      ),
    );
    raw.socket.destroy();
    await expect(withTimeout(setting, 500)).rejects.toMatchObject({
      code: "assignment_epoch_outcome_uncertain",
    });

    await Effect.runPromise(handle.close);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("requires a current live helper for each readiness generation and epoch", async () => {
    const opened = await openChannel("agent-supervisor-readiness");
    const { handle, scope } = opened;
    await expect(Effect.runPromise(handle.setAssignmentEpoch(1))).rejects.toMatchObject({
      code: "supervisor_helper_unavailable",
    });

    const first = spawnHelper(handle);
    await initialize(first.rpc);
    await Effect.runPromise(handle.awaitReady);
    await Effect.runPromise(handle.setAssignmentEpoch(1));
    const firstExit = waitForExit(first.child);
    first.child.kill("SIGTERM");
    await firstExit;
    await wait(20);
    await expect(Effect.runPromise(handle.setAssignmentEpoch(2))).rejects.toMatchObject({
      code: "supervisor_helper_unavailable",
    });

    const replacement = spawnHelper(handle);
    await initialize(replacement.rpc);
    await Effect.runPromise(handle.awaitReady);
    await Effect.runPromise(handle.setAssignmentEpoch(2));
    await Effect.runPromise(handle.close);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }, 20_000);

  it("queues a correlated cancellation when a helper disconnects with a pending question", async () => {
    const { handle, scope } = await openChannel("agent-supervisor-disconnect");
    const { child, rpc } = spawnHelper(handle);
    await initialize(rpc);
    await Effect.runPromise(handle.awaitReady);
    await Effect.runPromise(handle.setAssignmentEpoch(1));

    const pending = toolCall(rpc, "question-before-disconnect", "supervisor_question", {
      message: "Should I continue?",
    });
    void pending.catch(() => undefined);
    const questionEvent = await takeEvent(handle);
    expect(questionEvent).toMatchObject({
      type: "supervisor_contact",
      kind: "question",
      assignmentEpoch: 1,
    });
    if (questionEvent.type !== "supervisor_contact") throw new Error("expected question");

    const exited = waitForExit(child);
    child.kill("SIGKILL");
    await exited;
    expect(await takeEvent(handle)).toMatchObject({
      type: "supervisor_question_cancelled",
      assignmentEpoch: 1,
      requestId: questionEvent.requestId,
    });
    await expect(
      Effect.runPromise(handle.reply(questionEvent.requestId, "Continue.")),
    ).rejects.toMatchObject({ code: "question_ownership_mismatch" });

    await Effect.runPromise(handle.close);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("queues a correlated cancellation when the owning adapter cancels a question", async () => {
    const { handle, scope } = await openChannel("agent-supervisor-close-question");
    const { rpc } = spawnHelper(handle);
    await initialize(rpc);
    await Effect.runPromise(handle.awaitReady);
    await Effect.runPromise(handle.setAssignmentEpoch(1));

    const pending = toolCall(rpc, "question-before-close", "supervisor_question", {
      message: "Will the channel close?",
    });
    const questionEvent = await takeEvent(handle);
    if (questionEvent.type !== "supervisor_contact") throw new Error("expected question");
    handle.cancelPending("Adapter is closing the assignment.");
    expect(await pending).toMatchObject({ error: expect.anything() });
    expect(await takeEvent(handle)).toMatchObject({
      type: "supervisor_question_cancelled",
      assignmentEpoch: 1,
      requestId: questionEvent.requestId,
    });
    await Effect.runPromise(handle.close);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("reserves cancellation capacity for an accepted question under event saturation", async () => {
    const { handle, scope } = await openChannel("agent-supervisor-saturated");
    const config = await connectionConfig(handle);
    const { rpc } = spawnHelper(handle);
    await initialize(rpc);
    await Effect.runPromise(handle.awaitReady);
    await Effect.runPromise(handle.setAssignmentEpoch(1));
    await Effect.runPromise(handle.setAssignmentEpoch(2));

    const raw = await connectRawChannel(handle);
    await raw.request({
      version: 1,
      runId: handle.runId,
      token: config.token,
      type: "hello",
      id: "raw-saturation-hello",
    });
    for (let index = 0; index < 62; index += 1)
      await raw.request({
        version: 1,
        runId: handle.runId,
        token: config.token,
        type: "progress",
        id: `saturation-progress-${index}`,
        assignmentEpoch: 2,
        message: `Progress ${index}`,
      });

    const pending = toolCall(rpc, "saturated-question", "supervisor_question", {
      message: "Question at the reserved boundary?",
    });
    await wait(10);
    expect(
      await raw.request({
        version: 1,
        runId: handle.runId,
        token: config.token,
        type: "report",
        id: "older-report-at-saturation",
        assignmentEpoch: 1,
        deliveryId: "older-report-at-saturation",
        text: "Older assignment report.",
      }),
    ).toMatchObject({ type: "error", code: "event_queue_full" });
    rpc.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "saturated-question" },
    });
    expect(await pending).toMatchObject({ error: { code: -32800 } });

    const events: Array<Awaited<ReturnType<typeof takeEvent>>> = [];
    for (let index = 0; index < 64; index += 1) events.push(await takeEvent(handle));
    const saturatedQuestion = events.at(-2);
    expect(saturatedQuestion).toMatchObject({
      type: "supervisor_contact",
      kind: "question",
    });
    if (
      !saturatedQuestion ||
      !hasObjectRuntimeType(saturatedQuestion) ||
      !("requestId" in saturatedQuestion)
    )
      throw new Error("missing saturated question correlation");
    expect(events.at(-1)).toMatchObject({
      type: "supervisor_question_cancelled",
      assignmentEpoch: 2,
      requestId: saturatedQuestion.requestId,
    });

    raw.socket.destroy();
    await Effect.runPromise(handle.close);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }, 20_000);

  it("rejects bad auth, excess/malformed/oversized MCP input, and closes boundedly", async () => {
    const opened = await openChannel("agent-supervisor-malformed");
    const { handle, scope } = opened;
    const config = await connectionConfig(handle);

    const bad = await connectRawChannel(handle);
    const badClosed = new Promise<void>((resolve) => bad.socket.once("close", resolve));
    bad.socket.write(
      `${JSON.stringify({
        version: 1,
        runId: handle.runId,
        token: "0".repeat(64),
        type: "hello",
        id: "bad-auth",
      })}\n`,
    );
    await withTimeout(badClosed);
    expect(await Effect.runPromise(Queue.poll(handle.events))).toEqual(Option.none());
    expect(handle.metadata.host).toBe("127.0.0.1");
    expect(config.host).toBe("127.0.0.1");

    const { child, rpc } = spawnHelper(handle);
    await initialize(rpc);
    await Effect.runPromise(handle.awaitReady);
    await Effect.runPromise(handle.setAssignmentEpoch(1));
    const excessTopLevel = await rpc.request({
      jsonrpc: "2.0",
      id: "excess-top",
      method: "ping",
      params: {},
      unexpected: true,
    });
    expect(excessTopLevel).toMatchObject({ error: { code: -32600 } });
    const excessTool = await toolCall(rpc, "excess-tool", "supervisor_progress", {
      message: "valid",
      unexpected: true,
    });
    expect(excessTool).toMatchObject({ result: { isError: true } });
    const oversizedString = await toolCall(rpc, "oversized-tool", "supervisor_progress", {
      message: "x".repeat(16 * 1024 + 1),
    });
    expect(oversizedString).toMatchObject({ result: { isError: true } });

    child.stdin.write("{not-json}\n");
    expect(
      await rpc.next(
        (value) =>
          !!value &&
          hasObjectRuntimeType(value) &&
          "id" in value &&
          value.id === null &&
          "error" in value,
      ),
    ).toMatchObject({ error: { code: -32700 } });

    const oversizedExit = waitForExit(child);
    child.stdin.write(`${"x".repeat(512 * 1024 + 1)}\n`);
    expect(await oversizedExit).toBeDefined();
    await wait(10);
    await Effect.runPromise(handle.close);
    await expect(stat(handle.metadata.connectionConfigPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }, 20_000);
});
