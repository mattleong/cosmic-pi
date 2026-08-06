import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  herdrCommandExitFailure,
  selectHerdrEnvironment,
  type HerdrCommandRequest,
  type HerdrCommandRunner,
} from "../src/boundary/herdr-client.ts";
import type { HerdrForkSessionInput } from "../src/boundary/host-session.ts";
import { HerdrForkError } from "../src/fork/errors.ts";
import { makeAgentName, selectSplitDirection } from "../src/fork/policy.ts";
import { makeHerdrForkService } from "../src/fork/service.ts";

const SESSION_FILE = "/sessions/parent.jsonl";
const SESSION_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const CWD = "/project";

interface FixtureOptions {
  readonly width?: number;
  readonly protocol?: number;
  readonly integration?: string;
  readonly layoutWorkspaceId?: string;
  readonly splitTabId?: string;
  readonly startedSession?: string;
  readonly startedSessionKind?: "id" | "path";
  readonly shellReadyAfter?: number;
  readonly shellReadiness?: ReadonlyArray<boolean>;
  readonly failOperation?: string;
}

const commandFailure = (request: HerdrCommandRequest) =>
  new HerdrForkError({
    operation: request.operation,
    code: `fixture_${request.operation.replaceAll(" ", "_")}`,
    message: `Fixture failure during ${request.operation}.`,
    outcome: request.mutation ? "uncertain" : "confirmed",
  });

const fixture = (options: FixtureOptions = {}) => {
  const calls: HerdrCommandRequest[] = [];
  let shellInspections = 0;
  const parentPane = {
    pane_id: "w1:p1",
    terminal_id: "term-parent",
    workspace_id: "w1",
    tab_id: "w1:t1",
    cwd: CWD,
    foreground_cwd: CWD,
  };
  const forkPane = {
    pane_id: "w1:p2",
    terminal_id: "term-fork",
    workspace_id: "w1",
    tab_id: options.splitTabId ?? "w1:t1",
    cwd: CWD,
    foreground_cwd: CWD,
  };

  const runner: HerdrCommandRunner = (request) => {
    calls.push(request);
    if (request.operation === options.failOperation) return Effect.fail(commandFailure(request));

    switch (request.operation) {
      case "inspect protocol":
        return Effect.succeed({
          stdout: JSON.stringify({ protocol: options.protocol ?? 19, schema_version: 1 }),
          stderr: "",
        });
      case "inspect Pi integration":
        return Effect.succeed({
          stdout: options.integration ?? "pi: current (v8) (/agent/herdr-agent-state.ts)\n",
          stderr: "",
        });
      case "resolve calling pane":
        return Effect.succeed({
          stdout: JSON.stringify({ result: { pane: parentPane } }),
          stderr: "",
        });
      case "inspect calling pane layout":
        return Effect.succeed({
          stdout: JSON.stringify({
            result: {
              layout: {
                workspace_id: options.layoutWorkspaceId ?? "w1",
                tab_id: "w1:t1",
                area: { width: options.width ?? 160, height: 40 },
              },
            },
          }),
          stderr: "",
        });
      case "split fork pane":
        return Effect.succeed({
          stdout: JSON.stringify({ result: { pane: forkPane } }),
          stderr: "",
        });
      case "inspect fork pane shell": {
        shellInspections += 1;
        const ready =
          options.shellReadiness?.[shellInspections - 1] ??
          shellInspections >= (options.shellReadyAfter ?? 1);
        return Effect.succeed({
          stdout: JSON.stringify({
            result: {
              process_info: ready
                ? {
                    pane_id: forkPane.pane_id,
                    shell_pid: 4242,
                    foreground_process_group_id: 4242,
                    foreground_processes: [{ pid: 4242, name: "zsh" }],
                  }
                : { pane_id: forkPane.pane_id },
            },
          }),
          stderr: "",
        });
      }
      case "start forked Pi": {
        const agentName = request.args[2];
        return Effect.succeed({
          stdout: JSON.stringify({
            result: {
              agent: {
                ...forkPane,
                agent: "pi",
                name: agentName,
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: options.startedSessionKind ?? "path",
                  value: options.startedSession ?? "/sessions/child.jsonl",
                },
              },
            },
          }),
          stderr: "",
        });
      }
      case "prompt forked Pi":
      case "focus forked Pi":
        return Effect.succeed({ stdout: JSON.stringify({ result: {} }), stderr: "" });
      default:
        return Effect.fail(commandFailure(request));
    }
  };

  const input: HerdrForkSessionInput = {
    environment: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_WORKSPACE_ID: "w1",
    },
    cwd: CWD,
    sessionFile: SESSION_FILE,
    sessionId: SESSION_ID,
  };
  const service = makeHerdrForkService(input, {
    runner,
    validateSessionFile: () => true,
    readinessDelay: () => Effect.void,
  });

  return { calls, input, runner, service };
};

const operationNames = (calls: ReadonlyArray<HerdrCommandRequest>) =>
  calls.map((call) => call.operation);

describe("herdr-fork policy", () => {
  it("uses a right split only when the current pane is wide", () => {
    expect(selectSplitDirection(99)).toBe("down");
    expect(selectSplitDirection(100)).toBe("right");
  });

  it("generates bounded Herdr-safe agent names", () => {
    const name = makeAgentName("SESSION !!! WITH SPACES", "workspace:pane/999999999");
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/u);
    expect(name.length).toBeLessThanOrEqual(32);
  });

  it("classifies agent_pane_busy as a confirmed precondition rejection", () => {
    const failure = herdrCommandExitFailure(
      {
        args: ["agent", "start"],
        operation: "start forked Pi",
        mutation: true,
        confirmedRejectionCodes: ["agent_pane_busy"],
      },
      JSON.stringify({
        error: {
          code: "agent_pane_busy",
          message: "agent target pane w1:p2 is not an available shell",
        },
      }),
    );
    expect(failure).toMatchObject({
      code: "herdr_start_forked_pi_rejected",
      outcome: "confirmed",
      herdrCode: "agent_pane_busy",
    });
    expect(failure.message).toContain("was rejected before it was applied");
  });

  it("keeps undecodable mutating failures outcome-uncertain", () => {
    const failure = herdrCommandExitFailure(
      {
        args: ["agent", "start"],
        operation: "start forked Pi",
        mutation: true,
        confirmedRejectionCodes: ["agent_pane_busy"],
      },
      "connection closed",
    );
    expect(failure).toMatchObject({
      code: "herdr_start_forked_pi_outcome_uncertain",
      outcome: "uncertain",
    });
  });

  it("passes only bounded Herdr caller routing to the CLI process", () => {
    expect(
      selectHerdrEnvironment({
        HOME: "/home/test",
        PATH: "/bin",
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/private/herdr.sock",
        HERDR_PANE_ID: "w1:p1",
        PI_SESSION_FILE: SESSION_FILE,
        PI_SESSION_ID: SESSION_ID,
        SECRET: "do-not-pass",
      }),
    ).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/private/herdr.sock",
      HERDR_PANE_ID: "w1:p1",
    });
  });
});

describe("herdr-fork workflow", () => {
  it("splits, starts a native fork, safely prompts, focuses, and transfers ownership", () => {
    const test = fixture();
    return Effect.runPromise(test.service.open("--review the plan")).then((result) => {
      expect(result).toMatchObject({
        paneId: "w1:p2",
        childSession: "/sessions/child.jsonl",
        direction: "right",
        prompted: true,
      });
      expect(operationNames(test.calls).slice(0, 5)).toEqual([
        "inspect protocol",
        "inspect Pi integration",
        "resolve calling pane",
        "inspect calling pane layout",
        "split fork pane",
      ]);
      expect(
        test.calls.filter((call) => call.operation === "inspect fork pane shell"),
      ).toHaveLength(6);
      expect(operationNames(test.calls).slice(-3)).toEqual([
        "start forked Pi",
        "prompt forked Pi",
        "focus forked Pi",
      ]);
      expect(test.calls[4]?.args).toEqual([
        "pane",
        "split",
        "w1:p1",
        "--direction",
        "right",
        "--ratio",
        "0.5",
        "--cwd",
        CWD,
        "--no-focus",
      ]);
      const shellInspections = test.calls.filter(
        (call) => call.operation === "inspect fork pane shell",
      );
      expect(shellInspections[0]?.args).toEqual(["pane", "process-info", "--pane", "w1:p2"]);
      expect(shellInspections.every((call) => !call.mutation)).toBe(true);
      const start = test.calls.find((call) => call.operation === "start forked Pi");
      expect(start?.args).toEqual([
        "agent",
        "start",
        result.agentName,
        "--kind",
        "pi",
        "--pane",
        "w1:p2",
        "--timeout",
        "60000",
        "--",
        "--fork",
        SESSION_FILE,
        "--name",
        "Fork · project",
      ]);
      expect(start?.confirmedRejectionCodes).toEqual(["agent_pane_busy"]);
      expect(test.calls.find((call) => call.operation === "prompt forked Pi")?.args).toEqual([
        "agent",
        "prompt",
        result.agentName,
        "Initial fork request:\n--review the plan",
      ]);
      expect(test.calls.find((call) => call.operation === "focus forked Pi")?.args).toEqual([
        "agent",
        "focus",
        result.agentName,
      ]);
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
    });
  });

  it("uses a down split and omits prompt delivery when no prompt is supplied", () => {
    const test = fixture({ width: 80 });
    return Effect.runPromise(test.service.open()).then((result) => {
      expect(result.direction).toBe("down");
      expect(result.prompted).toBe(false);
      expect(operationNames(test.calls)).not.toContain("prompt forked Pi");
    });
  });

  it("waits through read-only shell inspections without retrying any mutation", () => {
    const test = fixture({ shellReadyAfter: 3 });
    return Effect.runPromise(test.service.open()).then(() => {
      const inspections = test.calls.filter((call) => call.operation === "inspect fork pane shell");
      expect(inspections).toHaveLength(8);
      expect(inspections.every((call) => !call.mutation)).toBe(true);
      for (const operation of ["split fork pane", "start forked Pi", "focus forked Pi"])
        expect(test.calls.filter((call) => call.operation === operation)).toHaveLength(1);
    });
  });

  it("resets stability after a transient shell-owned sample", () => {
    const test = fixture({
      shellReadiness: [true, true, false, true, true, true, true, true, true],
    });
    return Effect.runPromise(test.service.open()).then(() => {
      expect(
        test.calls.filter((call) => call.operation === "inspect fork pane shell"),
      ).toHaveLength(9);
      expect(test.calls.filter((call) => call.operation === "start forked Pi")).toHaveLength(1);
    });
  });

  it("retains the pane and skips Pi launch when its shell misses the readiness deadline", () => {
    const test = fixture({ shellReadyAfter: 100 });
    return Effect.runPromise(Effect.result(test.service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_fork_pane_shell_not_ready",
          outcome: "confirmed",
          paneId: "w1:p2",
        });
      expect(
        test.calls.filter((call) => call.operation === "inspect fork pane shell").length,
      ).toBeGreaterThan(1);
      expect(operationNames(test.calls)).not.toContain("start forked Pi");
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
    });
  });

  it("requires inherited Herdr caller identity before any CLI call", () => {
    const test = fixture();
    const service = makeHerdrForkService(
      { ...test.input, environment: { HERDR_ENV: "1" } },
      { runner: test.runner, validateSessionFile: () => true },
    );
    return Effect.runPromise(Effect.result(service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_environment_unavailable");
      expect(test.calls).toEqual([]);
    });
  });

  it("requires a regular persisted parent session before mutation", () => {
    const test = fixture();
    const service = makeHerdrForkService(test.input, {
      runner: test.runner,
      validateSessionFile: () => false,
    });
    return Effect.runPromise(Effect.result(service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("parent_session_unavailable");
      expect(test.calls).toEqual([]);
    });
  });

  it("rejects unsupported Herdr protocols before mutation", () => {
    const test = fixture({ protocol: 16 });
    return Effect.runPromise(Effect.result(test.service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("herdr_upgrade_required");
      expect(operationNames(test.calls)).toEqual(["inspect protocol"]);
    });
  });

  it("requires a current Pi integration before creating topology", () => {
    const test = fixture({ integration: "pi: outdated (v6 < v8) (/agent/herdr-agent-state.ts)\n" });
    return Effect.runPromise(Effect.result(test.service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_pi_integration_unavailable",
          outcome: "confirmed",
        });
      expect(operationNames(test.calls)).toEqual(["inspect protocol", "inspect Pi integration"]);
    });
  });

  it("rejects a layout that no longer belongs to the calling pane", () => {
    const test = fixture({ layoutWorkspaceId: "w2" });
    return Effect.runPromise(Effect.result(test.service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_parent_topology_mismatch");
      expect(operationNames(test.calls)).not.toContain("split fork pane");
    });
  });

  it("refuses to launch when the split escapes the calling tab", () => {
    const test = fixture({ splitTabId: "w1:t2" });
    return Effect.runPromise(Effect.result(test.service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_split_topology_mismatch",
          outcome: "uncertain",
          paneId: "w1:p2",
        });
      expect(operationNames(test.calls)).not.toContain("start forked Pi");
    });
  });

  it("retains the created pane when agent startup has an uncertain failure", () => {
    const test = fixture({ failOperation: "start forked Pi" });
    return Effect.runPromise(Effect.result(test.service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({ outcome: "uncertain", paneId: "w1:p2" });
        expect(result.failure.message).toContain("retained for manual inspection");
      }
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
    });
  });

  it("focuses a confirmed fork even when optional prompt delivery fails", () => {
    const test = fixture({ failOperation: "prompt forked Pi" });
    return Effect.runPromise(Effect.result(test.service.open("Prompt that may not arrive."))).then(
      (result) => {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.paneId).toBe("w1:p2");
          expect(result.failure.message).toContain("enter the prompt there manually");
        }
        expect(operationNames(test.calls).at(-1)).toBe("focus forked Pi");
      },
    );
  });

  it("reports a focus failure without closing a confirmed fork", () => {
    const test = fixture({ failOperation: "focus forked Pi" });
    return Effect.runPromise(Effect.result(test.service.open())).then((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.paneId).toBe("w1:p2");
        expect(result.failure.message).toContain("focus it manually");
      }
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
    });
  });

  it("requires a distinct path-based child session identity", () => {
    const sameSession = fixture({ startedSession: SESSION_FILE });
    const idSession = fixture({ startedSessionKind: "id" });
    return Effect.runPromise(
      Effect.all([
        Effect.result(sameSession.service.open()),
        Effect.result(idSession.service.open()),
      ]),
    ).then(([sameResult, idResult]) => {
      expect(sameResult._tag).toBe("Failure");
      expect(idResult._tag).toBe("Failure");
      if (sameResult._tag === "Failure")
        expect(sameResult.failure.code).toBe("herdr_agent_ownership_mismatch");
      if (idResult._tag === "Failure")
        expect(idResult.failure.code).toBe("herdr_agent_ownership_mismatch");
    });
  });
});
