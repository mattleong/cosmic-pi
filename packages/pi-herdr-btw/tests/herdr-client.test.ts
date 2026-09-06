import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { BoundedProcessError, type BoundedProcessRequest } from "pi-cosmic-core";
import { expect } from "vitest";
import { makeHerdrClient, type HerdrProcessRunner } from "../src/boundary/herdr-client.ts";

const parentPane = {
  pane_id: "w1:p1",
  terminal_id: "term-parent",
  workspace_id: "w1",
  tab_id: "w1:t1",
};
const childPane = {
  pane_id: "w1:p2",
  terminal_id: "term-child",
  workspace_id: "w1",
  tab_id: "w1:t1",
};

const success = (stdout: string) =>
  ({
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    overflowed: false,
    timedOut: false,
    cleanupUnconfirmed: false,
    dispatched: true,
  }) as const;

const responseFor = (request: BoundedProcessRequest) => {
  const args = request.args;
  if (args[0] === "api" && args[1] === "schema") return success('{"protocol":19}');
  if (args[0] === "integration") return success("pi: current (v8) (/agent/herdr-agent-state.ts)\n");
  if (args[0] === "pane" && args[1] === "current")
    return success(JSON.stringify({ result: { pane: parentPane } }));
  if (args[0] === "pane" && args[1] === "layout")
    return success(
      JSON.stringify({
        result: {
          layout: {
            workspace_id: "w1",
            tab_id: "w1:t1",
            area: { width: 160, height: 40 },
          },
        },
      }),
    );
  if (args[0] === "pane" && args[1] === "split")
    return success(JSON.stringify({ result: { pane: childPane } }));
  if (args[0] === "pane" && args[1] === "process-info")
    return success(
      JSON.stringify({
        result: {
          process_info: {
            pane_id: childPane.pane_id,
            shell_pid: 42,
            foreground_process_group_id: 42,
            foreground_processes: [{ pid: 42, name: "zsh" }],
          },
        },
      }),
    );
  if (args[0] === "api" && args[1] === "snapshot")
    return success(JSON.stringify({ result: { snapshot: { protocol: 19, agents: [childPane] } } }));
  if (args[0] === "agent" && args[1] === "start")
    return success(
      JSON.stringify({
        result: {
          agent: {
            ...childPane,
            agent: "pi",
            name: args[2],
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "path",
              value: "/sessions/child.jsonl",
            },
          },
        },
      }),
    );
  return success('{"result":{}}');
};

it.effect("isolates credentials and hostile arguments while bounding requests", () =>
  Effect.gen(function* () {
    const hostilePath = '/sessions/child $(touch /tmp/injected); "quoted".jsonl';
    const hostilePrompt = 'Review this\n$(touch /tmp/injected); "quoted" & exit';
    const captured: BoundedProcessRequest[] = [];
    const processRunner: HerdrProcessRunner = (request) =>
      Effect.sync(() => {
        captured.push(request);
        return responseFor(request);
      });
    const client = makeHerdrClient(
      {
        HOME: "/home/test",
        PATH: "/bin",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
        SECRET: "never-pass",
        OPENAI_API_KEY: "private-api-key",
        AWS_SESSION_TOKEN: "private-session-token",
      },
      { executable: "fixture-herdr", processRunner },
    );

    expect(yield* client.inspectProtocol()).toBe(19);
    expect(yield* client.inspectPiIntegration()).toBe(true);
    expect(yield* client.resolveCallingPane()).toEqual(parentPane);
    expect(yield* client.inspectPaneLayout(parentPane.pane_id)).toEqual({
      workspace_id: "w1",
      tab_id: "w1:t1",
      area: { width: 160, height: 40 },
    });
    expect(
      yield* client.splitPane({
        parentPaneId: parentPane.pane_id,
        direction: "right",
        cwd: hostilePath,
      }),
    ).toEqual(childPane);
    expect(yield* client.inspectPaneProcessInfo(childPane.pane_id)).toMatchObject({
      pane_id: childPane.pane_id,
      shell_pid: 42,
    });
    expect(yield* client.inspectLiveAgents()).toEqual([childPane]);
    const started = yield* client.startSideSessionPi({
      agentName: "btw-agent",
      paneId: childPane.pane_id,
      childSessionId: "child-id",
      childSessionPath: hostilePath,
      parentSessionId: "parent-id",
      parentSessionPath: "/sessions/parent.jsonl",
      displayName: "BTW · project",
    });
    expect(started).toMatchObject({ name: "btw-agent", agent: "pi" });
    yield* client.promptSideSessionPi("btw-agent", hostilePrompt);
    yield* client.focusSideSessionPi("btw-agent");

    const split = captured.find(({ args }) => args[0] === "pane" && args[1] === "split")!;
    expect(split.args[split.args.indexOf("--cwd") + 1]).toBe(hostilePath);
    const launch = captured.find(({ args }) => args[0] === "agent" && args[1] === "start")!;
    const childArgs = launch.args.slice(launch.args.indexOf("--") + 1);
    expect(childArgs[childArgs.indexOf("--session") + 1]).toBe(hostilePath);
    expect(childArgs).not.toContain("/sessions/parent.jsonl");
    expect(childArgs).not.toContain("--fork");
    const prompt = captured.find(({ args }) => args[0] === "agent" && args[1] === "prompt")!;
    expect(prompt.args.filter((arg) => arg === hostilePrompt)).toHaveLength(1);

    for (const request of captured) {
      // Direct executable plus argument arrays keep hostile input out of a shell.
      expect(request.executable).toBe("fixture-herdr");
      expect(request.args).not.toContain("-c");
      expect(request.environment).toMatchObject({
        HOME: "/home/test",
        PATH: "/bin",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
      });
      for (const key of ["SECRET", "OPENAI_API_KEY", "AWS_SESSION_TOKEN"]) {
        expect(request.environment).not.toHaveProperty(key);
      }
      for (const secret of ["never-pass", "private-api-key", "private-session-token"]) {
        expect(
          [...request.args, ...Object.values(request.environment ?? {})].join("\n"),
        ).not.toContain(secret);
      }
      for (const limit of [request.stdoutLimitBytes, request.stderrLimitBytes]) {
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(4 * 1024 * 1024);
      }
      expect(request.timeoutMillis).toBeGreaterThan(0);
      expect(request.timeoutMillis).toBeLessThanOrEqual(70_000);
      expect(request.cleanupTimeoutMillis).toBeGreaterThan(0);
      expect(request.cleanupTimeoutMillis).toBeLessThanOrEqual(1_000);
    }
  }),
);

it.effect("recognizes only a current Pi integration status", () =>
  Effect.gen(function* () {
    const cases = [
      ["current", "pi: current (v8) (/agent/herdr-agent-state.ts)\n", true],
      ["outdated", "pi: outdated (v6 < v8) (/agent/state.ts)\n", false],
      ["malformed", "pi: current (v8)\n", false],
      ["absent", "", false],
    ] as const;

    for (const [_case, stdout, expected] of cases) {
      const client = makeHerdrClient({}, { processRunner: () => Effect.succeed(success(stdout)) });
      expect(yield* client.inspectPiIntegration()).toBe(expected);
    }
  }),
);

it.effect("runs asynchronously and propagates interruption to the process", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let interrupted = 0;
    const processRunner: HerdrProcessRunner = () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => void interrupted++)),
      );
    const client = makeHerdrClient({}, { processRunner });
    const running = yield* client.inspectProtocol().pipe(Effect.forkScoped);
    yield* Deferred.await(started);

    yield* Fiber.interrupt(running);

    expect(interrupted).toBe(1);
    expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
  }),
);

it.effect("confirms only mutation failures that occur before process dispatch", () =>
  Effect.gen(function* () {
    for (const operation of ["spawn", "stream"] as const) {
      const processRunner: HerdrProcessRunner = () =>
        Effect.fail(new BoundedProcessError({ operation, message: "bounded fixture failure" }));
      const client = makeHerdrClient({}, { processRunner });
      const result = yield* Effect.result(
        client.splitPane({ parentPaneId: "w1:p1", direction: "right", cwd: "/project" }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code:
            operation === "spawn"
              ? "herdr_split_btw_pane_failed"
              : "herdr_split_btw_pane_outcome_uncertain",
          outcome: operation === "spawn" ? "confirmed" : "uncertain",
        });
    }
  }),
);

it.effect("fails closed when either output stream exceeds its byte bound", () =>
  Effect.gen(function* () {
    for (const stream of ["stdout", "stderr"] as const) {
      let limits: readonly [number, number] | undefined;
      const processRunner: HerdrProcessRunner = (request) =>
        Effect.sync(() => {
          limits = [request.stdoutLimitBytes, request.stderrLimitBytes];
          return { ...success('{"protocol":19}'), [stream]: "123456789", overflowed: true };
        });
      const client = makeHerdrClient({}, { processRunner, maximumOutputBytes: 8 });

      const result = yield* Effect.result(client.inspectProtocol());

      expect(limits).toEqual([8, 8]);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_inspect_protocol_failed",
          outcome: "confirmed",
        });
    }
  }),
);

it.effect("classifies transport uncertainty from the owned operation's mutation policy", () =>
  Effect.gen(function* () {
    for (const flag of ["overflowed", "timedOut", "cleanupUnconfirmed"] as const) {
      const processRunner: HerdrProcessRunner = () =>
        Effect.succeed({ ...success('{"protocol":19}'), [flag]: true });
      const client = makeHerdrClient({}, { processRunner });
      const read = yield* Effect.result(client.inspectProtocol());
      const mutation = yield* Effect.result(
        client.splitPane({ parentPaneId: "w1:p1", direction: "right", cwd: "/project" }),
      );

      expect(read._tag).toBe("Failure");
      expect(mutation._tag).toBe("Failure");
      if (read._tag === "Failure")
        expect(read.failure).toMatchObject({
          code: "herdr_inspect_protocol_failed",
          outcome: "confirmed",
        });
      if (mutation._tag === "Failure")
        expect(mutation.failure).toMatchObject({
          code: "herdr_split_btw_pane_outcome_uncertain",
          outcome: "uncertain",
        });
    }
  }),
);

it.effect("keeps the owned start precondition rejection confirmed", () =>
  Effect.gen(function* () {
    const processRunner: HerdrProcessRunner = () =>
      Effect.succeed({
        ...success(""),
        code: 1,
        stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "busy" } }),
      });
    const client = makeHerdrClient({}, { processRunner });
    const result = yield* Effect.result(
      client.startSideSessionPi({
        agentName: "btw-agent",
        paneId: "w1:p2",
        childSessionId: "child-id",
        childSessionPath: "/sessions/child.jsonl",
        parentSessionId: "parent-id",
        parentSessionPath: "/sessions/parent.jsonl",
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        code: "herdr_start_side_session_pi_rejected",
        outcome: "confirmed",
        herdrCode: "agent_pane_busy",
      });
  }),
);

it.effect("sanitizes and bounds uncertain mutation exit diagnostics", () =>
  Effect.gen(function* () {
    const credential = "hunter2";
    const processRunner: HerdrProcessRunner = () =>
      Effect.succeed({
        ...success(""),
        code: 1,
        stderr: `password=${credential} \u0000${"x".repeat(3_000)}`,
      });
    const client = makeHerdrClient({}, { processRunner });

    const result = yield* Effect.result(
      client.splitPane({ parentPaneId: "w1:p1", direction: "right", cwd: "/project" }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        code: "herdr_split_btw_pane_outcome_uncertain",
        outcome: "uncertain",
      });
      expect(result.failure.message).toContain("password=[REDACTED]");
      expect(result.failure.message).not.toContain(credential);
      expect(result.failure.message).not.toContain("\u0000");
      expect(result.failure.message).toMatch(/…$/u);
      expect(result.failure.message.length).toBeLessThanOrEqual(2_100);
    }
  }),
);

it.effect("keeps undecodable mutation exits and responses outcome-uncertain", () =>
  Effect.gen(function* () {
    const exitClient = makeHerdrClient(
      {},
      {
        processRunner: () =>
          Effect.succeed({ ...success(""), code: 1, stderr: "connection closed" }),
      },
    );
    const decodeClient = makeHerdrClient(
      {},
      {
        processRunner: () => Effect.succeed(success("not json")),
      },
    );
    const input = { parentPaneId: "w1:p1", direction: "right" as const, cwd: "/project" };

    for (const result of [
      yield* Effect.result(exitClient.splitPane(input)),
      yield* Effect.result(decodeClient.splitPane(input)),
    ]) {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toMatchObject({ outcome: "uncertain" });
    }
  }),
);
