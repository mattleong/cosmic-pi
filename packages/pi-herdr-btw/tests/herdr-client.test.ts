import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
  }) as const;

const responseFor = (request: BoundedProcessRequest) => {
  const args = request.args;
  if (args[0] === "pane" && args[1] === "split")
    return success(JSON.stringify({ result: { pane: childPane } }));
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
        PI_CODING_AGENT_DIR: "/home/test/custom-pi",
        PI_CONFIG_DIR: "/home/test/pi-config",
        XDG_CONFIG_HOME: "/home/test/xdg-config",
        XDG_STATE_HOME: "/home/test/xdg-state",
        PI_SESSION_FILE: "/sessions/parent.jsonl",
        PI_SESSION_ID: "parent-session-id",
        SECRET: "never-pass",
        OPENAI_API_KEY: "private-api-key",
        AWS_SESSION_TOKEN: "private-session-token",
      },
      { processRunner },
    );

    expect(
      yield* client.splitPane({
        parentPaneId: parentPane.pane_id,
        direction: "right",
        cwd: hostilePath,
      }),
    ).toEqual(childPane);
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
    for (const inspect of [
      client.inspectProtocol(),
      client.inspectPiIntegration(),
      client.resolveCallingPane(),
      client.inspectPaneLayout(parentPane.pane_id),
      client.inspectPaneProcessInfo(childPane.pane_id),
      client.inspectLiveAgents(),
    ]) {
      const issued = captured.length;
      yield* Effect.ignore(inspect);
      expect(captured.length).toBeGreaterThan(issued);
    }

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
      expect(request.executable).toBe("herdr");
      expect(request.args).not.toContain("-c");
      expect(request.environment).toMatchObject({
        HOME: "/home/test",
        PATH: "/bin",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
        PI_CODING_AGENT_DIR: "/home/test/custom-pi",
        PI_CONFIG_DIR: "/home/test/pi-config",
        XDG_CONFIG_HOME: "/home/test/xdg-config",
        XDG_STATE_HOME: "/home/test/xdg-state",
      });
      for (const key of [
        "SECRET",
        "OPENAI_API_KEY",
        "AWS_SESSION_TOKEN",
        "PI_SESSION_FILE",
        "PI_SESSION_ID",
      ]) {
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

it.effect("confirms only mutation failures that occur before process dispatch", () =>
  Effect.gen(function* () {
    for (const operation of ["spawn", "stream"] as const) {
      const processRunner: HerdrProcessRunner = () =>
        Effect.fail(new BoundedProcessError({ operation, message: "bounded fixture failure" }));
      const client = makeHerdrClient({}, { processRunner });
      const error = yield* Effect.flip(
        client.splitPane({ parentPaneId: "w1:p1", direction: "right", cwd: "/project" }),
      );

      expect(error).toMatchObject({
        code:
          operation === "spawn"
            ? "herdr_split_btw_pane_failed"
            : "herdr_split_btw_pane_outcome_uncertain",
        outcome: operation === "spawn" ? "confirmed" : "uncertain",
      });
    }
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

    const error = yield* Effect.flip(
      client.splitPane({ parentPaneId: "w1:p1", direction: "right", cwd: "/project" }),
    );

    expect(error).toMatchObject({
      code: "herdr_split_btw_pane_outcome_uncertain",
      outcome: "uncertain",
    });
    expect(error.message).toContain("password=[REDACTED]");
    expect(error.message).not.toContain(credential);
    expect(error.message).not.toContain("\u0000");
    expect(error.message.length).toBeLessThanOrEqual(2_100);
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

    for (const client of [exitClient, decodeClient])
      expect(yield* Effect.flip(client.splitPane(input))).toMatchObject({ outcome: "uncertain" });
  }),
);

it.effect("recognizes a current Pi integration across status wording changes", () =>
  Effect.gen(function* () {
    const integrationFor = (stdout: string) =>
      makeHerdrClient(
        {},
        { processRunner: () => Effect.succeed(success(stdout)) },
      ).inspectPiIntegration();

    for (const line of [
      "pi: current (v9) (/home/test/.pi/agent/extensions/herdr-agent-state.ts)",
      "pi: current",
      "pi:  current v10 at /home/test/custom-pi/extensions/herdr-agent-state.ts",
    ])
      expect(yield* integrationFor(`claude: current (v10) (/x)\n${line}\n`)).toBe(true);
    for (const line of [
      "pi: not installed (/home/test/.pi/agent/extensions/herdr-agent-state.ts)",
      "pi: outdated (v8) (/home/test/.pi/agent/extensions/herdr-agent-state.ts)",
      "omp: current (v10) (/home/test/.omp/agent/extensions/herdr-omp-agent-state.ts)",
    ])
      expect(yield* integrationFor(`${line}\n`)).toBe(false);
  }),
);

const piAgent = {
  ...childPane,
  agent: "pi",
  name: "btw-agent",
  agent_session: {
    source: "herdr:pi",
    agent: "pi",
    kind: "path",
    value: "/sessions/child.jsonl",
  },
};
const snapshotClient = (agents: ReadonlyArray<unknown>) =>
  makeHerdrClient(
    {},
    {
      processRunner: () =>
        Effect.succeed(success(JSON.stringify({ result: { snapshot: { protocol: 1, agents } } }))),
    },
  );

it.effect("keeps live Pi agents when an unrelated agent has an unexpected shape", () =>
  Effect.gen(function* () {
    const agents = yield* snapshotClient([
      {
        ...parentPane,
        agent: "future-agent",
        name: "x".repeat(500),
        agent_session: { source: "herdr:future", agent: "future", kind: "uri", value: "" },
      },
      { pane_id: 7, agent: "claude" },
      "not an agent",
      piAgent,
    ]).inspectLiveAgents();

    expect(agents).toEqual([piAgent]);
  }),
);

it.effect("rejects a snapshot whose Pi agent is malformed", () =>
  Effect.gen(function* () {
    for (const malformed of [
      { ...piAgent, agent_session: { ...piAgent.agent_session, kind: "uri" } },
      { ...piAgent, agent: "renamed", name: "x".repeat(500) },
      { ...piAgent, agent: null, terminal_id: "" },
    ]) {
      const error = yield* Effect.flip(snapshotClient([piAgent, malformed]).inspectLiveAgents());
      expect(error).toMatchObject({
        code: "herdr_inspect_live_agents_protocol_invalid",
        outcome: "confirmed",
      });
    }
  }),
);
