// Fixture process and filesystem ownership are intentional integration-test boundaries.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
// @effect-diagnostics effect/processEnv:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import {
  claudeArgv,
  claudeSettings,
  makeLocalCliProcess,
} from "../src/boundary/local-cli-process.ts";
import type {
  SupervisorChannelHandle,
  SupervisorChannelShape,
} from "../src/boundary/supervisor-channel.ts";
import { makeLocalClaudeBackendDriver } from "../src/backend/local-claude.ts";
import {
  claudeInterruptFrame,
  decodeClaudeProtocolEvent,
} from "../src/backend/local-claude-protocol.ts";
import { makeLocalCodexBackendDriver } from "../src/backend/local-codex.ts";
import {
  decodeCodexNotification,
  threadStartRequest,
  turnStartRequest,
} from "../src/backend/local-codex-protocol.ts";
import type { BackendEvent, BackendLaunchRequest } from "../src/backend/model.ts";

const fixture = fileURLToPath(new URL("./fixtures/local-cli-fixture.mjs", import.meta.url));

const launch = (
  runtime: "claude" | "codex",
  model = `${runtime}-fixture`,
): BackendLaunchRequest => ({
  runId: `agent-${runtime}`,
  name: `${runtime}-worker`,
  closeOnReport: true,
  cwd: process.cwd(),
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  model,
  effort: "xhigh",
  activeTools: [],
  projectTrusted: true,
  parentSessionId: "parent-session",
  systemPrompt: "Use the private supervisor report tool.",
});

interface SupervisorFixture {
  readonly shape: SupervisorChannelShape;
  readonly epochs: number[];
  readonly replies: Array<{ readonly requestId: string; readonly message: string }>;
  readonly readyCalls: () => number;
  readonly acceptReport: (epoch: number) => void;
  readonly current: () => SupervisorChannelHandle;
}

const supervisorFixture = (): SupervisorFixture => {
  const epochs: number[] = [];
  const replies: Array<{ readonly requestId: string; readonly message: string }> = [];
  const acceptedReports = new Set<number>();
  let handle: SupervisorChannelHandle | undefined;
  let readyCalls = 0;
  const shape: SupervisorChannelShape = {
    open: (request) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<
          Extract<BackendEvent, { readonly type: "supervisor_contact" | "report" }>,
          Cause.Done
        >();
        handle = {
          runId: request.runId,
          metadata: {
            runId: request.runId,
            host: "127.0.0.1",
            port: 1,
            stateDirectory: "/private/fixture",
            connectionConfigPath: "/private/fixture/connection.json",
            helperPath: "/private/helper.mjs",
            claudeMcp: {
              mcpServers: {
                pi_subagents_supervisor: {
                  type: "stdio",
                  command: process.execPath,
                  args: ["/private/helper.mjs"],
                  env: {},
                },
              },
            },
            codexMcp: {
              serverName: "pi_subagents_supervisor",
              command: process.execPath,
              args: ["/private/helper.mjs"],
              enabledTools: [
                "supervisor_progress",
                "supervisor_warning",
                "supervisor_question",
                "supervisor_submit_report",
              ],
              tomlFragment: [
                "[mcp_servers.pi_subagents_supervisor]",
                `command = ${JSON.stringify(process.execPath)}`,
                `args = [${JSON.stringify("/private/helper.mjs")}]`,
                "required = true",
              ].join("\n"),
            },
          },
          events,
          awaitReady: Effect.sync(() => void (readyCalls += 1)),
          setAssignmentEpoch: (epoch) => Effect.sync(() => void epochs.push(epoch)),
          hasAcceptedReport: (epoch) => Effect.succeed(acceptedReports.has(epoch)),
          acceptedReportForEpoch: (epoch) =>
            Effect.succeed(
              acceptedReports.has(epoch)
                ? {
                    runId: request.runId,
                    assignmentEpoch: epoch,
                    sequence: 1,
                    deliveryId: `accepted-${epoch}`,
                    text: "Accepted fixture report.",
                  }
                : undefined,
            ),
          reply: (requestId, message) =>
            Effect.sync(() => void replies.push({ requestId, message })),
          cancelPending: () => {},
          close: Effect.sync(() => Queue.endUnsafe(events)),
        };
        return handle;
      }),
  };
  return {
    shape,
    epochs,
    replies,
    readyCalls: () => readyCalls,
    acceptReport: (epoch) => void acceptedReports.add(epoch),
    current: () => {
      if (!handle) throw new Error("supervisor fixture not opened");
      return handle;
    },
  };
};

const makeTempHarness = async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-local-cli-"));
  const home = join(directory, "home");
  await fs.mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    join(home, ".codex", "auth.json"),
    `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture" } })}\n`,
    { mode: 0o600 },
  );
  return {
    directory,
    processes: makeLocalCliProcess({
      agentDirectory: directory,
      executables: { claude: fixture, codex: fixture },
      environment: {
        HOME: home,
        PATH: process.env.PATH,
        LANG: "C",
        TEST_SECRET: "must-not-cross",
      },
    }),
  };
};

const take = <A>(queue: Queue.Dequeue<A, Cause.Done>) =>
  Queue.take(queue).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.flatMap((value) =>
      value._tag === "Some" ? Effect.succeed(value.value) : Effect.die("fixture event timeout"),
    ),
  );

describe("local CLI Phase One backends", () => {
  it("decodes Claude tool-result lifecycle events without misclassifying stream replay", async () => {
    await expect(
      Effect.runPromise(
        decodeClaudeProtocolEvent({
          type: "user",
          session_id: "session",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: false }],
          },
        }),
      ),
    ).resolves.toEqual({
      type: "user",
      text: "",
      toolResults: [{ id: "tool-1", isError: false }],
      sessionId: "session",
      isSynthetic: false,
      isReplay: false,
    });
  });

  it("accepts Claude system status events without weakening init validation", async () => {
    await expect(
      Effect.runPromise(
        decodeClaudeProtocolEvent({
          type: "system",
          subtype: "status",
          status: "requesting",
          session_id: "session",
          uuid: "status-event",
        }),
      ),
    ).resolves.toEqual({ type: "activity" });
    await expect(
      Effect.runPromise(
        decodeClaudeProtocolEvent({
          type: "system",
          subtype: "future_lifecycle_event",
          session_id: "session",
        }),
      ),
    ).resolves.toEqual({ type: "ignored" });
    await expect(
      Effect.runPromise(
        decodeClaudeProtocolEvent({
          type: "system",
          subtype: "init",
          session_id: "session",
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("decodes each current Codex warning notification shape", async () => {
    await expect(
      Effect.runPromise(decodeCodexNotification("warning", { message: "Runtime warning" })),
    ).resolves.toEqual({ type: "warning", message: "Runtime warning" });
    await expect(
      Effect.runPromise(
        decodeCodexNotification("configWarning", {
          summary: "Invalid config",
          details: "Use the supported key.",
          path: "/private/config.toml",
        }),
      ),
    ).resolves.toEqual({
      type: "warning",
      message: "Invalid config\nUse the supported key.",
    });
    await expect(
      Effect.runPromise(
        decodeCodexNotification("deprecationNotice", {
          summary: "Deprecated option",
          details: null,
        }),
      ),
    ).resolves.toEqual({ type: "warning", message: "Deprecated option" });
    const bounded = await Effect.runPromise(
      decodeCodexNotification("warning", { message: `  ${"x".repeat(20 * 1024)}  ` }),
    );
    expect(bounded).toMatchObject({ type: "warning" });
    expect(bounded.type === "warning" ? bounded.message.length : 0).toBe(16 * 1024);
  });

  it("uses fixed Claude and Codex read-only/writer policy builders", () => {
    const paths = {
      settingsPath: "/private/settings.json",
      mcpPath: "/private/mcp.json",
      promptPath: "/private/prompt.md",
    };
    const readArgs = claudeArgv(launch("claude"), paths);
    const writeArgs = claudeArgv({ ...launch("claude"), writeIntent: "writer" }, paths);
    const readTools = readArgs[readArgs.indexOf("--tools") + 1];
    const writeTools = writeArgs[writeArgs.indexOf("--tools") + 1];
    const writerAllowed = writeArgs[writeArgs.indexOf("--allowedTools") + 1]?.split(",") ?? [];
    expect(readTools).not.toContain("Bash");
    expect(readTools).not.toContain("Write");
    expect(writeTools).toContain("Bash");
    expect(writeTools).toContain("Edit");
    expect(writeTools).not.toContain("Write");
    expect(writerAllowed).not.toContain("Bash");
    expect(writerAllowed).not.toContain("Edit");
    expect(writerAllowed).not.toContain("Write");
    expect(writerAllowed).toContain(`Edit(/${process.cwd()}/**)`);
    expect(readArgs[readArgs.indexOf("--disallowedTools") + 1]).toContain("Agent");
    expect(readArgs).toContain("--strict-mcp-config");
    expect(
      readArgs.slice(
        readArgs.indexOf("--setting-sources"),
        readArgs.indexOf("--setting-sources") + 2,
      ),
    ).toEqual(["--setting-sources", ""]);
    expect(readArgs).not.toContain("--safe-mode");
    expect(claudeInterruptFrame("interrupt-1")).toMatchObject({
      request: { subtype: "interrupt", cancel_queued: true },
    });
    expect(claudeSettings({ ...launch("claude"), writeIntent: "writer" })).toMatchObject({
      permissions: {
        defaultMode: "dontAsk",
        allow: expect.arrayContaining([`Edit(/${process.cwd()}/**)`]),
      },
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: [process.cwd()] },
        network: {
          allowedDomains: [],
          strictAllowlist: true,
          allowAllUnixSockets: false,
          allowLocalBinding: false,
        },
      },
    });

    expect(
      threadStartRequest("1", {
        cwd: "/project",
        model: "gpt-5.6-sol",
        systemPrompt: "fixed",
        writeIntent: "read-only",
        fastMode: false,
      }).params,
    ).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: [],
      environments: [],
    });
    expect(
      turnStartRequest("2", "thread", "task", "gpt-5.6-sol", "xhigh", "writer", false).params,
    ).toMatchObject({
      approvalPolicy: "never",
      effort: "xhigh",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    });
    expect(
      threadStartRequest("3", {
        cwd: "/project",
        model: "gpt-5.6-sol",
        systemPrompt: "fixed",
        writeIntent: "read-only",
        fastMode: true,
      }).params.serviceTier,
    ).toBe("priority");
    expect(
      turnStartRequest("4", "thread", "task", "gpt-5.6-sol", "high", "read-only", true).params
        .serviceTier,
    ).toBe("priority");
  });

  it("runs Claude stream JSON with confirmed guidance/interrupt and supervisor correlation", async () => {
    const harness = await makeTempHarness();
    const supervisor = supervisorFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const driver = makeLocalClaudeBackendDriver(harness.processes, supervisor.shape);
            if (driver.preflight)
              yield* driver.preflight({
                context: "fresh",
                writeIntent: "read-only",
                closeOnReport: true,
                model: "claude-fixture",
                effort: "xhigh",
              });
            const backend = yield* driver.spawn(launch("claude"));
            expect(yield* backend.controls.initialize).toMatchObject({
              model: "claude-fixture",
              effort: "xhigh",
              sessionId: "claude-fixture-session",
            });
            yield* backend.controls.start("Initial task", 7);
            expect(yield* take(backend.events)).toEqual({
              type: "run_started",
              assignmentEpoch: 7,
            });
            const assistant = yield* take(backend.events);
            expect(assistant).toMatchObject({
              type: "assistant_message",
              assignmentEpoch: 7,
              usage: { input: 3, output: 4, cacheRead: 1, totalTokens: 7 },
            });
            expect(assistant.type === "assistant_message" ? assistant.text : "").toContain(
              "envLeak=none",
            );
            backend.acknowledge(assistant);
            yield* backend.controls.steer("Focus guidance");
            expect(yield* take(backend.events)).toMatchObject({
              type: "assistant_message",
              text: expect.stringContaining("Focus guidance"),
            });
            yield* backend.controls.interrupt;

            Queue.offerUnsafe(
              supervisor.current().events as Queue.Queue<BackendEvent, Cause.Done>,
              {
                type: "supervisor_contact",
                assignmentEpoch: 7,
                requestId: "question-7",
                kind: "question",
                message: "Proceed?",
              },
            );
            expect(yield* take(backend.events)).toMatchObject({
              type: "supervisor_contact",
              requestId: "question-7",
            });
            yield* backend.controls.reply("question-7", "Proceed");
            Queue.offerUnsafe(
              supervisor.current().events as Queue.Queue<BackendEvent, Cause.Done>,
              {
                type: "report",
                runId: "agent-claude",
                assignmentEpoch: 7,
                sequence: 11,
                deliveryId: "delivery-11",
                text: "Claude report",
                evidence: "fixture",
              },
            );
            expect(yield* take(backend.events)).toEqual({
              type: "report",
              runId: "agent-claude",
              assignmentEpoch: 7,
              sequence: 11,
              deliveryId: "delivery-11",
              text: "Claude report",
              evidence: "fixture",
            });
          }),
        ),
      );
      expect(supervisor.epochs).toEqual([7]);
      expect(supervisor.replies).toEqual([{ requestId: "question-7", message: "Proceed" }]);
    } finally {
      await fs.rm(harness.directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("correlates Claude interrupt marker/result before its control response and preserves genuine errors", async () => {
    for (const model of [
      "interrupt-terminal-first",
      "interrupt-result-first",
      "interrupt-genuine-error",
    ] as const) {
      const harness = await makeTempHarness();
      const supervisor = supervisorFixture();
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const backend = yield* makeLocalClaudeBackendDriver(
                harness.processes,
                supervisor.shape,
              ).spawn(launch("claude", model));
              yield* backend.controls.initialize;
              yield* backend.controls.start("Interrupt fixture", 1);
              yield* take(backend.events);
              yield* take(backend.events);
              const interrupting = yield* backend.controls.interrupt.pipe(Effect.forkScoped);
              if (model !== "interrupt-genuine-error") {
                yield* Fiber.join(interrupting);
                expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
              } else {
                expect(yield* take(backend.events)).toMatchObject({
                  type: "protocol_error",
                  message: expect.stringContaining("genuine fixture failure"),
                });
                yield* Fiber.interrupt(interrupting);
              }
            }),
          ),
        );
      } finally {
        await fs.rm(harness.directory, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it("fails Claude startup on invalid initialize or missing mandatory supervisor inventory", async () => {
    for (const [model, code] of [
      ["bad-init", "claude_initialize_invalid"],
      ["missing-helper", "claude_supervisor_mcp_unavailable"],
    ] as const) {
      const harness = await makeTempHarness();
      const supervisor = supervisorFixture();
      try {
        await expect(
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const backend = yield* makeLocalClaudeBackendDriver(
                  harness.processes,
                  supervisor.shape,
                ).spawn(launch("claude", model));
                return yield* backend.controls.initialize;
              }),
            ),
          ),
        ).rejects.toMatchObject({ code });
      } finally {
        await fs.rm(harness.directory, { recursive: true, force: true });
      }
    }
  });

  it("fails fast mode when Codex does not confirm the priority service tier", async () => {
    const harness = await makeTempHarness();
    const supervisor = supervisorFixture();
    try {
      await expect(
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const backend = yield* makeLocalCodexBackendDriver(
                harness.processes,
                supervisor.shape,
              ).spawn({ ...launch("codex", "service-tier-mismatch"), fastMode: true });
              return yield* backend.controls.initialize;
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "SubagentProtocolError",
        message: expect.stringContaining("instead of required priority fast mode"),
      });
    } finally {
      await fs.rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("runs the Codex app-server v2 subset with confirmed start/steer/interrupt and usage", async () => {
    const harness = await makeTempHarness();
    const supervisor = supervisorFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const driver = makeLocalCodexBackendDriver(harness.processes, supervisor.shape);
            if (driver.preflight)
              yield* driver.preflight({
                context: "fresh",
                writeIntent: "read-only",
                closeOnReport: true,
                model: "codex-fixture",
                effort: "xhigh",
              });
            const backend = yield* driver.spawn({ ...launch("codex"), fastMode: true });
            expect(yield* backend.controls.initialize).toMatchObject({
              model: "codex-fixture",
              effort: "xhigh",
              sessionId: "session-fixture",
            });
            yield* backend.controls.start("Codex task", 9);
            const observed: BackendEvent[] = [];
            for (let index = 0; index < 3; index += 1) observed.push(yield* take(backend.events));
            expect(observed).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ type: "run_started", assignmentEpoch: 9 }),
                expect.objectContaining({
                  type: "assistant_message",
                  text: "Codex fixture answer",
                }),
                expect.objectContaining({
                  type: "assistant_message",
                  usage: expect.objectContaining({
                    input: 2,
                    output: 3,
                    cacheRead: 1,
                    totalTokens: 5,
                  }),
                }),
              ]),
            );
            yield* backend.controls.steer("Steer safely");
            yield* backend.controls.interrupt;
            expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
            Queue.offerUnsafe(
              supervisor.current().events as Queue.Queue<BackendEvent, Cause.Done>,
              {
                type: "report",
                runId: "agent-codex",
                assignmentEpoch: 9,
                sequence: 3,
                deliveryId: "codex-delivery-3",
                text: "Codex report",
              },
            );
            expect(yield* take(backend.events)).toMatchObject({
              type: "report",
              sequence: 3,
              deliveryId: "codex-delivery-3",
            });
          }),
        ),
      );
      expect(supervisor.epochs).toEqual([9]);
      expect(supervisor.readyCalls()).toBe(1);
    } finally {
      await fs.rm(harness.directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("awaits Codex interrupted completion when its notification precedes the RPC response", async () => {
    const harness = await makeTempHarness();
    const supervisor = supervisorFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* makeLocalCodexBackendDriver(
              harness.processes,
              supervisor.shape,
            ).spawn(launch("codex", "interrupt-notification-first"));
            yield* backend.controls.initialize;
            yield* backend.controls.start("Codex task", 9);
            for (let index = 0; index < 3; index += 1) yield* take(backend.events);
            yield* backend.controls.interrupt;
            expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
          }),
        ),
      );
    } finally {
      await fs.rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("fails closed when Codex reports an unowned interrupted turn", async () => {
    const harness = await makeTempHarness();
    const supervisor = supervisorFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* makeLocalCodexBackendDriver(
              harness.processes,
              supervisor.shape,
            ).spawn(launch("codex", "interrupted-without-request"));
            yield* backend.controls.initialize;
            yield* backend.controls.start("Codex task", 9);
            for (let index = 0; index < 3; index += 1) yield* take(backend.events);
            expect(yield* take(backend.events)).toMatchObject({
              type: "protocol_error",
              message: "Codex turn was interrupted without a matching parent interrupt lifecycle.",
            });
          }),
        ),
      );
    } finally {
      await fs.rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("requires an exact causal Claude report for every successful assignment result", async () => {
    for (const acceptedEpoch of [9, 8, undefined]) {
      const harness = await makeTempHarness();
      const supervisor = supervisorFixture();
      if (acceptedEpoch !== undefined) supervisor.acceptReport(acceptedEpoch);
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const backend = yield* makeLocalClaudeBackendDriver(
                harness.processes,
                supervisor.shape,
              ).spawn(launch("claude", "completed-with-report"));
              yield* backend.controls.initialize;
              yield* backend.controls.start("Claude task", 9);
              expect(yield* take(backend.events)).toMatchObject({
                type: "run_started",
                assignmentEpoch: 9,
              });
              expect(yield* take(backend.events)).toMatchObject({
                type: "assistant_message",
                assignmentEpoch: 9,
              });
              if (acceptedEpoch === 9)
                expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
              else
                expect(yield* take(backend.events)).toMatchObject({
                  type: "protocol_error",
                  message: "Claude Code result completed without an accepted supervisor report.",
                });
            }),
          ),
        );
      } finally {
        await fs.rm(harness.directory, { recursive: true, force: true });
      }
    }
  });

  it("uses causal supervisor acceptance instead of a scheduling grace at Codex completion", async () => {
    for (const accepted of [true, false]) {
      const harness = await makeTempHarness();
      const supervisor = supervisorFixture();
      if (accepted) supervisor.acceptReport(9);
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const backend = yield* makeLocalCodexBackendDriver(
                harness.processes,
                supervisor.shape,
              ).spawn(
                launch("codex", accepted ? "completed-with-report" : "completed-without-report"),
              );
              yield* backend.controls.initialize;
              yield* backend.controls.start("Codex task", 9);
              for (let index = 0; index < 3; index += 1) yield* take(backend.events);
              if (accepted) expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
              else
                expect(yield* take(backend.events)).toMatchObject({
                  type: "protocol_error",
                  message: "Codex turn completed without an accepted supervisor report.",
                });
            }),
          ),
        );
      } finally {
        await fs.rm(harness.directory, { recursive: true, force: true });
      }
    }
  });

  it("preserves an accepted supervisor report when Claude exits before queue forwarding", async () => {
    const harness = await makeTempHarness();
    const supervisor = supervisorFixture();
    supervisor.acceptReport(9);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* makeLocalClaudeBackendDriver(
              harness.processes,
              supervisor.shape,
            ).spawn(launch("claude", "exit-no-report"));
            yield* backend.controls.initialize;
            yield* backend.controls.start("Claude task", 9);
            expect(yield* take(backend.events)).toMatchObject({ type: "run_started" });
            expect(yield* take(backend.events)).toMatchObject({ type: "assistant_message" });
            expect(yield* take(backend.events)).toMatchObject({
              type: "report",
              assignmentEpoch: 9,
              deliveryId: "accepted-9",
            });
          }),
        ),
      );
    } finally {
      await fs.rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("preserves an accepted supervisor report when Codex exits before queue forwarding", async () => {
    const harness = await makeTempHarness();
    const supervisor = supervisorFixture();
    supervisor.acceptReport(9);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* makeLocalCodexBackendDriver(
              harness.processes,
              supervisor.shape,
            ).spawn(launch("codex", "exit-no-report"));
            yield* backend.controls.initialize;
            yield* backend.controls.start("Codex task", 9);
            for (let index = 0; index < 3; index += 1) yield* take(backend.events);
            expect(yield* take(backend.events)).toMatchObject({
              type: "report",
              assignmentEpoch: 9,
              deliveryId: "accepted-9",
            });
          }),
        ),
      );
    } finally {
      await fs.rm(harness.directory, { recursive: true, force: true });
    }
  });

  it("fails bounded preflight before spawn for unsupported effort/auth/executable", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-preflight-"));
    try {
      const noAuth = makeLocalCliProcess({
        agentDirectory: directory,
        executables: { claude: fixture, codex: fixture },
        environment: { HOME: join(directory, "empty-home"), PATH: process.env.PATH },
      });
      await expect(
        Effect.runPromise(
          noAuth.preflight({
            runtime: "codex",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
            model: "gpt",
            effort: "xhigh",
          }),
        ),
      ).rejects.toMatchObject({ code: "codex_harness_auth_unavailable" });
      await expect(
        Effect.runPromise(
          noAuth.preflight({
            runtime: "claude",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
            model: "claude",
            effort: "off",
          }),
        ),
      ).rejects.toMatchObject({ code: "claude_effort_unsupported" });
      for (const runtime of ["claude", "codex"] as const)
        for (const model of ["-unsafe-model", "model with spaces", "model,(glob)*"])
          await expect(
            Effect.runPromise(
              noAuth.preflight({
                runtime,
                context: "fresh",
                writeIntent: "read-only",
                closeOnReport: true,
                model,
                effort: "xhigh",
              }),
            ),
          ).rejects.toMatchObject({ code: `${runtime}_model_unsupported` });
      const apiFallback = makeLocalCliProcess({
        agentDirectory: directory,
        executables: { claude: fixture, codex: fixture },
        environment: {
          HOME: join(directory, "empty-home"),
          PATH: process.env.PATH,
          OPENAI_API_KEY: "fixture-api-key",
        },
      });
      await expect(
        Effect.runPromise(
          apiFallback.preflight({
            runtime: "codex",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
            model: "gpt",
            effort: "max",
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        Effect.runPromise(
          noAuth.preflight({
            runtime: "claude",
            context: "fresh",
            writeIntent: "writer",
            closeOnReport: true,
            model: "claude",
            effort: "xhigh",
            cwd: "/project/(unsafe)",
          }),
        ),
      ).rejects.toMatchObject({ code: "claude_writer_confinement_unsupported" });
      const missing = makeLocalCliProcess({
        agentDirectory: directory,
        executables: { claude: join(directory, "missing"), codex: fixture },
        environment: { HOME: directory, PATH: process.env.PATH },
      });
      await expect(
        Effect.runPromise(
          missing.preflight({
            runtime: "claude",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
            model: "claude",
            effort: "xhigh",
          }),
        ),
      ).rejects.toMatchObject({ code: "claude_executable_unavailable" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("honors a bounded custom CODEX_HOME auth source without exposing that source as child state", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-custom-codex-home-"));
    const home = join(directory, "home");
    const sourceCodexHome = join(directory, "source-codex-home");
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await fs.mkdir(sourceCodexHome, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(sourceCodexHome, "auth.json"),
      `${JSON.stringify({ source: "custom-codex-home" })}\n`,
      { mode: 0o600 },
    );
    const processes = makeLocalCliProcess({
      agentDirectory: directory,
      executables: { claude: fixture, codex: fixture },
      environment: {
        HOME: home,
        CODEX_HOME: sourceCodexHome,
        PATH: process.env.PATH,
      },
    });
    const supervisor = supervisorFixture();
    try {
      await Effect.runPromise(
        processes.preflight({
          runtime: "codex",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: true,
          model: "codex-fixture",
          effort: "xhigh",
        }),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* makeLocalCodexBackendDriver(processes, supervisor.shape).spawn({
              ...launch("codex"),
              fastMode: true,
            });
            const root = join(directory, "subagents", "local-cli-v1");
            const entries = yield* Effect.promise(() => fs.readdir(root));
            const harnessDirectory = join(root, entries[0]!);
            const copied = yield* Effect.promise(() =>
              fs.readFile(join(harnessDirectory, "codex-home", "auth.json"), "utf8"),
            );
            expect(JSON.parse(copied)).toEqual({ source: "custom-codex-home" });
            const config = yield* Effect.promise(() =>
              fs.readFile(join(harnessDirectory, "codex-home", "config.toml"), "utf8"),
            );
            expect(config).toContain("fast_mode = true");
            expect(harnessDirectory).not.toContain(sourceCodexHome);
            yield* backend.controls.initialize;
          }),
        ),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("removes sensitive partial harnesses after post-auth failure and distinguishes uncertain cleanup", async () => {
    for (const cleanupUnconfirmed of [false, true]) {
      const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-harness-cleanup-"));
      const home = join(directory, "home");
      await fs.mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        join(home, ".codex", "auth.json"),
        `${JSON.stringify({ sensitive: "fixture-auth" })}\n`,
        { mode: 0o600 },
      );
      const processes = makeLocalCliProcess({
        agentDirectory: directory,
        executables: { claude: fixture, codex: fixture },
        environment: { HOME: home, PATH: process.env.PATH },
        harnessFault: "after-codex-auth",
        harnessCleanupFault: cleanupUnconfirmed,
      });
      const supervisor = supervisorFixture();
      try {
        await expect(
          Effect.runPromise(
            Effect.scoped(
              makeLocalCodexBackendDriver(processes, supervisor.shape).spawn(launch("codex")),
            ),
          ),
        ).rejects.toMatchObject({
          code: cleanupUnconfirmed ? "harness_cleanup_unconfirmed" : "harness_prepare_failed",
        });
        const harnessRoot = join(directory, "subagents", "local-cli-v1");
        expect(await fs.readdir(harnessRoot)).toHaveLength(cleanupUnconfirmed ? 1 : 0);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("turns malformed and oversized Claude frames into bounded protocol failures", async () => {
    for (const model of ["malformed", "oversized"] as const) {
      const harness = await makeTempHarness();
      const supervisor = supervisorFixture();
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const backend = yield* makeLocalClaudeBackendDriver(
                harness.processes,
                supervisor.shape,
              ).spawn(launch("claude", model));
              yield* backend.controls.initialize;
              yield* backend.controls.start("Trigger frame", 1);
              expect(yield* take(backend.events)).toMatchObject({ type: "run_started" });
              expect(yield* take(backend.events)).toMatchObject({ type: "protocol_error" });
            }),
          ),
        );
      } finally {
        await fs.rm(harness.directory, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("exposes a no-report process exit rather than treating raw CLI final text as completion", async () => {
    const harness = await makeTempHarness();
    const supervisor = supervisorFixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* makeLocalClaudeBackendDriver(
              harness.processes,
              supervisor.shape,
            ).spawn(launch("claude", "exit-no-report"));
            yield* backend.controls.initialize;
            yield* backend.controls.start("Exit", 1);
            const exit = yield* backend.awaitExit;
            expect(exit).toMatchObject({ type: "exit", exitCode: 0 });
            const events: BackendEvent[] = [];
            while (true) {
              const next = Queue.poll(backend.events);
              const option = yield* next;
              if (option._tag === "None") break;
              events.push(option.value);
            }
            expect(events.some((event) => event.type === "report")).toBe(false);
          }),
        ),
      );
    } finally {
      await fs.rm(harness.directory, { recursive: true, force: true });
    }
  }, 20_000);
});
