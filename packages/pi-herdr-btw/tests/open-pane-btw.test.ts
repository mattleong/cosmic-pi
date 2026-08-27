import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import {
  selectHerdrEnvironment,
  type HerdrCommandRequest,
  type HerdrCommandRunner,
} from "../src/boundary/herdr-client.ts";
import type { HerdrBtwLinkStore } from "../src/boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "../src/boundary/host-session.ts";
import { HerdrBtwError } from "../src/btw/errors.ts";
import type { HerdrBtwLink } from "../src/btw/link.ts";
import { makeAgentName, selectSplitDirection } from "../src/btw/policy.ts";
import { makeHerdrBtwService } from "../src/btw/service.ts";

const SESSION_FILE = "/sessions/parent.jsonl";
const SESSION_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const CHILD_ID = "0198aaaa-7564-4c88-8b67-child0btw001";
const CHILD_FILE = "/sessions/child.jsonl";
const CWD = "/project";

interface FixtureOptions {
  readonly width?: number;
  readonly protocol?: number;
  readonly integration?: string;
  readonly layoutWorkspaceId?: string;
  readonly splitTabId?: string;
  readonly startedSession?: string;
  readonly startedSessionKind?: "id" | "path";
  readonly startedIdentityAvailable?: boolean;
  readonly startedTerminalId?: string;
  readonly shellReadyAfter?: number;
  readonly shellReadiness?: ReadonlyArray<boolean>;
  readonly failOperation?: string;
}

const commandFailure = (request: HerdrCommandRequest) =>
  new HerdrBtwError({
    operation: request.operation,
    code: `fixture_${request.operation.toLowerCase().replaceAll(" ", "_")}`,
    message: `Fixture failure during ${request.operation}.`,
    outcome: request.mutation ? "uncertain" : "confirmed",
  });

const fixture = (options: FixtureOptions = {}) => {
  const calls: HerdrCommandRequest[] = [];
  let shellInspections = 0;
  let startedAgentName: string | undefined;
  const parentPane = {
    pane_id: "w1:p1",
    terminal_id: "term-parent",
    workspace_id: "w1",
    tab_id: "w1:t1",
    cwd: CWD,
    foreground_cwd: CWD,
  };
  const btwPane = {
    pane_id: "w1:p2",
    terminal_id: "term-btw",
    workspace_id: "w1",
    tab_id: options.splitTabId ?? "w1:t1",
    cwd: CWD,
    foreground_cwd: CWD,
  };
  const startedAgentSnapshot = (agentName: string) => {
    const agent = {
      ...btwPane,
      terminal_id: options.startedTerminalId ?? btwPane.terminal_id,
      agent: "pi",
      name: agentName,
    };
    if (options.startedIdentityAvailable === false) return agent;
    return {
      ...agent,
      agent_session: {
        source: "herdr:pi",
        agent: "pi",
        kind: options.startedSessionKind ?? "path",
        value: options.startedSession ?? "/sessions/child.jsonl",
      },
    };
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
      case "split BTW pane":
        return Effect.succeed({
          stdout: JSON.stringify({ result: { pane: btwPane } }),
          stderr: "",
        });
      case "inspect BTW pane shell": {
        shellInspections += 1;
        const ready =
          options.shellReadiness?.[shellInspections - 1] ??
          shellInspections >= (options.shellReadyAfter ?? 1);
        return Effect.succeed({
          stdout: JSON.stringify({
            result: {
              process_info: ready
                ? {
                    pane_id: btwPane.pane_id,
                    shell_pid: 4242,
                    foreground_process_group_id: 4242,
                    foreground_processes: [{ pid: 4242, name: "zsh" }],
                  }
                : { pane_id: btwPane.pane_id },
            },
          }),
          stderr: "",
        });
      }
      case "start side-session Pi": {
        const agentName = request.args[2] ?? "";
        startedAgentName = agentName;
        return Effect.succeed({
          stdout: JSON.stringify({
            result: { agent: startedAgentSnapshot(agentName) },
          }),
          stderr: "",
        });
      }
      case "inspect live agents":
        // Post-readiness identity: the started agent reports its child session.
        return Effect.succeed({
          stdout: JSON.stringify({
            result: {
              snapshot: {
                protocol: 20,
                agents:
                  startedAgentName === undefined
                    ? []
                    : [
                        {
                          ...btwPane,
                          agent: "pi",
                          name: startedAgentName,
                          agent_session: {
                            source: "herdr:pi",
                            agent: "pi",
                            kind: "path",
                            value: CHILD_FILE,
                          },
                        },
                      ],
              },
            },
          }),
          stderr: "",
        });
      case "prompt side-session Pi":
      case "focus side-session Pi":
        return Effect.succeed({ stdout: JSON.stringify({ result: {} }), stderr: "" });
      default:
        return Effect.fail(commandFailure(request));
    }
  };

  const input: HerdrBtwSessionInput = {
    environment: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_WORKSPACE_ID: "w1",
    },
    cwd: CWD,
    sessionFile: SESSION_FILE,
    sessionId: SESSION_ID,
    sessionDir: "/sessions",
  };
  const recordedLinks: HerdrBtwLink[] = [];
  const linkStore: HerdrBtwLinkStore = {
    restore: () => {
      const link = recordedLinks.at(-1);
      return link === undefined ? { _tag: "none" } : { _tag: "restored", link };
    },
    record: (link) => {
      recordedLinks.push(link);
      return true;
    },
  };
  const makeService = makeHerdrBtwService(input, linkStore, {
    runner,
    validateSessionFile: () => true,
    probeSessionHeader: (path) =>
      path === CHILD_FILE ? { _tag: "valid", header: { id: CHILD_ID } } : { _tag: "invalid" },
    createChildSessionId: () => CHILD_ID,
    createBlankChildSessionFile: () => ({ _tag: "created", path: CHILD_FILE }),
  });
  const open = (prompt?: string | undefined) =>
    Effect.flatMap(makeService, (service) => service.open(prompt));

  return { calls, input, linkStore, makeService, open, recordedLinks, runner };
};

const operationNames = (calls: ReadonlyArray<HerdrCommandRequest>) =>
  calls.map((call) => call.operation);

/**
 * Forks a workflow that sleeps through the shell-readiness window, then advances the
 * TestClock past the documented maximum of 30 readiness sleeps before joining. The
 * bounded loop cannot hang even when the pane never becomes ready.
 */
const withShellReadiness = <A, E>(workflow: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* workflow.pipe(Effect.forkScoped({ startImmediately: true }));
    for (let step = 0; step < 32; step += 1) yield* TestClock.adjust("200 millis");
    return yield* Fiber.join(fiber);
  });

describe("herdr-btw policy", () => {
  it("uses a right split only when the current pane is wide", () => {
    expect(selectSplitDirection(99)).toBe("down");
    expect(selectSplitDirection(100)).toBe("right");
  });

  it("generates bounded Herdr-safe agent names", () => {
    const name = makeAgentName("SESSION !!! WITH SPACES", "workspace:pane/999999999");
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/u);
    expect(name.length).toBeLessThanOrEqual(32);
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

describe("herdr-btw workflow", () => {
  it.effect(
    "splits, starts a blank side session, safely prompts, focuses, and transfers ownership",
    () =>
      Effect.gen(function* () {
        const test = fixture();
        const result = yield* withShellReadiness(test.open("--review the plan"));
        expect(result).toMatchObject({
          paneId: "w1:p2",
          direction: "right",
          prompted: true,
          mode: "created",
        });
        expect(test.recordedLinks).toEqual([
          {
            version: 1,
            parentSessionId: SESSION_ID,
            parentSessionPath: SESSION_FILE,
            childSessionId: CHILD_ID,
            childSessionPath: CHILD_FILE,
            agentName: result.agentName,
            terminalId: "term-btw",
          },
        ]);
        expect(operationNames(test.calls).slice(0, 5)).toEqual([
          "inspect protocol",
          "inspect Pi integration",
          "resolve calling pane",
          "inspect calling pane layout",
          "split BTW pane",
        ]);
        expect(
          test.calls.filter((call) => call.operation === "inspect BTW pane shell"),
        ).toHaveLength(6);
        expect(operationNames(test.calls).slice(-3)).toEqual([
          "start side-session Pi",
          "prompt side-session Pi",
          "focus side-session Pi",
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
          (call) => call.operation === "inspect BTW pane shell",
        );
        expect(shellInspections[0]?.args).toEqual(["pane", "process-info", "--pane", "w1:p2"]);
        expect(shellInspections.every((call) => !call.mutation)).toBe(true);
        const start = test.calls.find((call) => call.operation === "start side-session Pi");
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
          "--session",
          CHILD_FILE,
          "--name",
          "BTW · project",
          `--herdr-btw-parent=${SESSION_ID}`,
          `--herdr-btw-parent-file=${SESSION_FILE}`,
          `--herdr-btw-child-session=${CHILD_ID}`,
        ]);
        expect(start?.confirmedRejectionCodes).toEqual(["agent_pane_busy"]);
        expect(
          test.calls.find((call) => call.operation === "prompt side-session Pi")?.args,
        ).toEqual([
          "agent",
          "prompt",
          result.agentName,
          "Side-session request:\n--review the plan",
        ]);
        expect(test.calls.find((call) => call.operation === "focus side-session Pi")?.args).toEqual(
          ["agent", "focus", result.agentName],
        );
        expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
      }),
  );

  it.effect("uses a down split and omits prompt delivery when no prompt is supplied", () =>
    Effect.gen(function* () {
      const test = fixture({ width: 80 });
      const result = yield* withShellReadiness(test.open());
      expect(result.direction).toBe("down");
      expect(result.prompted).toBe(false);
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
    }),
  );

  it.effect("waits through read-only shell inspections without retrying any mutation", () =>
    Effect.gen(function* () {
      const test = fixture({ shellReadyAfter: 3 });
      yield* withShellReadiness(test.open());
      const inspections = test.calls.filter((call) => call.operation === "inspect BTW pane shell");
      expect(inspections).toHaveLength(8);
      expect(inspections.every((call) => !call.mutation)).toBe(true);
      for (const operation of ["split BTW pane", "start side-session Pi", "focus side-session Pi"])
        expect(test.calls.filter((call) => call.operation === operation)).toHaveLength(1);
    }),
  );

  it.effect("accepts exact atomic startup while Pi session metadata is still pending", () =>
    Effect.gen(function* () {
      const test = fixture({ startedIdentityAvailable: false });
      const result = yield* withShellReadiness(test.open("Review the BTW session."));
      expect(result).toMatchObject({ paneId: "w1:p2", prompted: true, mode: "created" });
      // The precreated blank child path remains authoritative even while
      // Herdr's optional native session metadata is still pending.
      expect(operationNames(test.calls).slice(-3)).toEqual([
        "start side-session Pi",
        "prompt side-session Pi",
        "focus side-session Pi",
      ]);
      expect(test.recordedLinks).toHaveLength(1);
      expect(test.recordedLinks[0]).toMatchObject({
        childSessionId: CHILD_ID,
        childSessionPath: CHILD_FILE,
      });
      expect(operationNames(test.calls)).not.toContain("confirm side-session Pi identity");
      expect(test.calls.filter((call) => call.operation === "start side-session Pi")).toHaveLength(
        1,
      );
    }),
  );

  it.effect("does not prompt or adopt mismatched atomic startup evidence", () =>
    Effect.gen(function* () {
      const test = fixture({ startedTerminalId: "term-other" });
      const result = yield* Effect.result(withShellReadiness(test.open("Do not misroute this.")));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_agent_ownership_mismatch",
          outcome: "uncertain",
          paneId: "w1:p2",
        });
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
      expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
      expect(test.calls.filter((call) => call.operation === "start side-session Pi")).toHaveLength(
        1,
      );
      expect(test.recordedLinks).toEqual([]);
    }),
  );

  it.effect("resets stability after a transient shell-owned sample", () =>
    Effect.gen(function* () {
      const test = fixture({
        shellReadiness: [true, true, false, true, true, true, true, true, true],
      });
      yield* withShellReadiness(test.open());
      expect(test.calls.filter((call) => call.operation === "inspect BTW pane shell")).toHaveLength(
        9,
      );
      expect(test.calls.filter((call) => call.operation === "start side-session Pi")).toHaveLength(
        1,
      );
    }),
  );

  it.effect("structurally retains the pane when a shell-readiness inspection fails", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "inspect BTW pane shell" });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          code: "fixture_inspect_btw_pane_shell",
          outcome: "confirmed",
          paneId: "w1:p2",
        });
        expect(result.failure.message).toContain("retained for manual inspection");
      }
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
    }),
  );

  it.effect(
    "retains the pane and skips Pi launch when its shell misses the readiness deadline",
    () =>
      Effect.gen(function* () {
        const test = fixture({ shellReadyAfter: 100 });
        const result = yield* Effect.result(withShellReadiness(test.open()));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            code: "herdr_btw_pane_shell_not_ready",
            outcome: "confirmed",
            paneId: "w1:p2",
          });
        expect(
          test.calls.filter((call) => call.operation === "inspect BTW pane shell"),
        ).toHaveLength(31);
        expect(operationNames(test.calls)).not.toContain("start side-session Pi");
        expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
      }),
  );

  it.effect("requires inherited Herdr caller identity before any CLI call", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* makeHerdrBtwService(
        { ...test.input, environment: { HERDR_ENV: "1" } },
        test.linkStore,
        { runner: test.runner, validateSessionFile: () => true },
      );
      const result = yield* Effect.result(service.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_environment_unavailable");
      expect(test.calls).toEqual([]);
    }),
  );

  it.effect("requires a regular persisted parent session before mutation", () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* makeHerdrBtwService(test.input, test.linkStore, {
        runner: test.runner,
        validateSessionFile: () => false,
      });
      const result = yield* Effect.result(service.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("parent_session_unavailable");
      expect(test.calls).toEqual([]);
    }),
  );

  it.effect("rejects unsupported Herdr protocols before mutation", () =>
    Effect.gen(function* () {
      const test = fixture({ protocol: 16 });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("herdr_upgrade_required");
      expect(operationNames(test.calls)).toEqual(["inspect protocol"]);
    }),
  );

  it.effect("requires a current Pi integration before creating topology", () =>
    Effect.gen(function* () {
      const test = fixture({
        integration: "pi: outdated (v6 < v8) (/agent/herdr-agent-state.ts)\n",
      });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_pi_integration_unavailable",
          outcome: "confirmed",
        });
      expect(operationNames(test.calls)).toEqual(["inspect protocol", "inspect Pi integration"]);
    }),
  );

  it.effect("rejects a layout that no longer belongs to the calling pane", () =>
    Effect.gen(function* () {
      const test = fixture({ layoutWorkspaceId: "w2" });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("herdr_parent_topology_mismatch");
        expect(result.failure.paneId).toBeUndefined();
      }
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("refuses to launch when the split escapes the calling tab", () =>
    Effect.gen(function* () {
      const test = fixture({ splitTabId: "w1:t2" });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_split_topology_mismatch",
          outcome: "uncertain",
          paneId: "w1:p2",
        });
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect("retains the created pane when agent startup has an uncertain failure", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "start side-session Pi" });
      const result = yield* Effect.result(withShellReadiness(test.open()));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({ outcome: "uncertain", paneId: "w1:p2" });
        expect(result.failure.message).toContain("retained for manual inspection");
      }
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
      expect(test.recordedLinks).toEqual([]);
    }),
  );

  it.effect("focuses a confirmed BTW session even when optional prompt delivery fails", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "prompt side-session Pi" });
      const result = yield* Effect.result(
        withShellReadiness(test.open("Prompt that may not arrive.")),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.paneId).toBe("w1:p2");
        expect(result.failure.message).toContain("enter the prompt there manually");
      }
      expect(operationNames(test.calls).at(-1)).toBe("focus side-session Pi");
    }),
  );

  it.effect("reports a focus failure without closing a confirmed BTW session", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "focus side-session Pi" });
      const result = yield* Effect.result(withShellReadiness(test.open()));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.paneId).toBe("w1:p2");
        expect(result.failure.message).toContain("focus it manually");
      }
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
    }),
  );

  it.effect("requires a distinct path-based child session identity", () =>
    Effect.gen(function* () {
      const sameSession = fixture({ startedSession: SESSION_FILE });
      const idSession = fixture({ startedSessionKind: "id" });
      const sameResult = yield* Effect.result(withShellReadiness(sameSession.open()));
      const idResult = yield* Effect.result(withShellReadiness(idSession.open()));
      expect(sameResult._tag).toBe("Failure");
      expect(idResult._tag).toBe("Failure");
      if (sameResult._tag === "Failure")
        expect(sameResult.failure.code).toBe("herdr_agent_ownership_mismatch");
      if (idResult._tag === "Failure")
        expect(idResult.failure.code).toBe("herdr_agent_ownership_mismatch");
    }),
  );
});
