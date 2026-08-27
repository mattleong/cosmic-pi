import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import type { HerdrCommandRequest, HerdrCommandRunner } from "../src/boundary/herdr-client.ts";
import type { HerdrBtwLinkStore } from "../src/boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "../src/boundary/host-session.ts";
import type { SessionHeaderProbe } from "../src/boundary/session-file.ts";
import { HerdrBtwError } from "../src/btw/errors.ts";
import {
  HERDR_BTW_LINK_ENTRY_TYPE,
  restoreHerdrBtwLink,
  type HerdrBtwLink,
  type HerdrBtwLinkRestoration,
} from "../src/btw/link.ts";
import { makeHerdrBtwService } from "../src/btw/service.ts";

const SESSION_FILE = "/sessions/parent.jsonl";
const SESSION_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const CHILD_ID = "0198aaaa-7564-4c88-8b67-child0btw001";
const CHILD_FILE = "/sessions/child.jsonl";
const NEW_CHILD_ID = "0198bbbb-7564-4c88-8b67-child0btw002";
const NEW_CHILD_FILE = "/sessions/child-new.jsonl";
const CWD = "/project";

const OWNER = { sessionId: SESSION_ID, sessionPath: SESSION_FILE } as const;

const LINK: HerdrBtwLink = {
  version: 1,
  parentSessionId: SESSION_ID,
  parentSessionPath: SESSION_FILE,
  childSessionId: CHILD_ID,
  childSessionPath: CHILD_FILE,
  agentName: "btw-019fd4cd-4c88-1-p2",
  terminalId: "term-btw",
};

interface SnapshotAgentOverrides {
  readonly pane_id?: string;
  readonly terminal_id?: string;
  readonly name?: string;
  readonly agent_session?: {
    readonly source: string;
    readonly agent: string;
    readonly kind: string;
    readonly value: string;
  };
}

const liveChildAgent = (overrides: SnapshotAgentOverrides = {}) => ({
  pane_id: "w1:p2",
  terminal_id: "term-btw",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "pi",
  name: LINK.agentName,
  agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: CHILD_FILE },
  ...overrides,
});

interface FixtureOptions {
  readonly initialLinks?: ReadonlyArray<HerdrBtwLink>;
  readonly restoreOverride?: HerdrBtwLinkRestoration;
  readonly liveAgents?: ReadonlyArray<unknown>;
  readonly liveAgentSnapshots?: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly probes?: Readonly<Record<string, SessionHeaderProbe>>;
  readonly recordFails?: boolean;
  readonly failOperation?: string;
  readonly startedSession?: string;
  readonly createdChildId?: string;
  readonly sessionId?: string;
  readonly holdStart?: Deferred.Deferred<void>;
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
  let startedAgentName: string | undefined;
  let startedSessionValue: string | undefined;
  let snapshotReads = 0;
  const parentPane = {
    pane_id: "w1:p1",
    terminal_id: "term-parent",
    workspace_id: "w1",
    tab_id: "w1:t1",
  };
  const btwPane = {
    pane_id: "w1:p2",
    terminal_id: "term-btw",
    workspace_id: "w1",
    tab_id: "w1:t1",
  };

  const respond = (
    request: HerdrCommandRequest,
  ): Effect.Effect<{ stdout: string; stderr: string }, HerdrBtwError> => {
    if (request.operation === options.failOperation) return Effect.fail(commandFailure(request));
    switch (request.operation) {
      case "inspect protocol":
        return Effect.succeed({ stdout: JSON.stringify({ protocol: 20 }), stderr: "" });
      case "inspect Pi integration":
        return Effect.succeed({
          stdout: "pi: current (v8) (/agent/herdr-agent-state.ts)\n",
          stderr: "",
        });
      case "inspect live agents":
        return Effect.succeed({
          stdout: JSON.stringify({
            result: {
              snapshot: {
                protocol: 20,
                agents:
                  options.liveAgentSnapshots?.[snapshotReads++] ??
                  options.liveAgents ??
                  (startedAgentName === undefined
                    ? []
                    : [
                        liveChildAgent({
                          name: startedAgentName,
                          agent_session: {
                            source: "herdr:pi",
                            agent: "pi",
                            kind: "path",
                            value: startedSessionValue ?? CHILD_FILE,
                          },
                        }),
                      ]),
              },
            },
          }),
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
                workspace_id: "w1",
                tab_id: "w1:t1",
                area: { width: 160, height: 40 },
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
      case "inspect BTW pane shell":
        return Effect.succeed({
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: btwPane.pane_id,
                shell_pid: 4242,
                foreground_process_group_id: 4242,
                foreground_processes: [{ pid: 4242, name: "zsh" }],
              },
            },
          }),
          stderr: "",
        });
      case "start side-session Pi": {
        const agentName = request.args[2] ?? "";
        startedAgentName = agentName;
        const sessionIndex = request.args.indexOf("--session");
        const sessionValue =
          options.startedSession ??
          (sessionIndex === -1
            ? NEW_CHILD_FILE
            : (request.args[sessionIndex + 1] ?? NEW_CHILD_FILE));
        startedSessionValue = sessionValue;
        const started = Effect.succeed({
          stdout: JSON.stringify({
            result: {
              agent: {
                ...btwPane,
                agent: "pi",
                name: agentName,
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
                  kind: "path",
                  value: sessionValue,
                },
              },
            },
          }),
          stderr: "",
        });
        return options.holdStart === undefined
          ? started
          : Effect.flatMap(Deferred.await(options.holdStart), () => started);
      }
      case "prompt side-session Pi":
      case "focus side-session Pi":
        return Effect.succeed({ stdout: JSON.stringify({ result: {} }), stderr: "" });
      default:
        return Effect.fail(commandFailure(request));
    }
  };
  const runner: HerdrCommandRunner = (request) =>
    Effect.suspend(() => {
      calls.push(request);
      return respond(request);
    });

  const input: HerdrBtwSessionInput = {
    environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    cwd: CWD,
    sessionFile: SESSION_FILE,
    sessionId: options.sessionId ?? SESSION_ID,
    sessionDir: "/sessions",
  };
  const recordedLinks: HerdrBtwLink[] = [...(options.initialLinks ?? [])];
  const linkStore: HerdrBtwLinkStore = {
    restore: () => {
      if (options.restoreOverride) return options.restoreOverride;
      const link = recordedLinks.at(-1);
      return link === undefined ? { _tag: "none" } : { _tag: "restored", link };
    },
    record: (link) => {
      if (options.recordFails) return false;
      recordedLinks.push(link);
      return true;
    },
  };
  const probeFor = (path: string): SessionHeaderProbe => {
    const override = options.probes?.[path];
    if (override) return override;
    if (path === CHILD_FILE) return { _tag: "valid", header: { id: CHILD_ID } };
    if (path === NEW_CHILD_FILE) return { _tag: "valid", header: { id: NEW_CHILD_ID } };
    return { _tag: "invalid" };
  };
  const makeService = makeHerdrBtwService(input, linkStore, {
    runner,
    validateSessionFile: () => true,
    probeSessionHeader: probeFor,
    createChildSessionId: () => options.createdChildId ?? NEW_CHILD_ID,
    createBlankChildSessionFile: () => ({ _tag: "created", path: NEW_CHILD_FILE }),
  });
  const open = (prompt?: string | undefined) =>
    Effect.flatMap(makeService, (service) => service.open(prompt));
  const openNew = (prompt?: string | undefined) =>
    Effect.flatMap(makeService, (service) => service.openNew(prompt));

  return { calls, linkStore, makeService, open, openNew, recordedLinks };
};

const operationNames = (calls: ReadonlyArray<HerdrCommandRequest>) =>
  calls.map((call) => call.operation);

/** Advances the TestClock through the bounded shell-readiness window. */
const withReadiness = <A, E>(workflow: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* workflow.pipe(Effect.forkScoped({ startImmediately: true }));
    for (let step = 0; step < 40; step += 1) yield* TestClock.adjust("500 millis");
    return yield* Fiber.join(fiber);
  });

describe("herdr-btw link restoration", () => {
  const linkEntry = <Data>(data: Data) => ({
    type: "custom",
    id: "e1",
    parentId: null,
    timestamp: "2026-08-26T00:00:00.000Z",
    customType: HERDR_BTW_LINK_ENTRY_TYPE,
    data,
  });

  it("reports none without any link entry", () => {
    expect(
      restoreHerdrBtwLink(
        [
          { type: "message", id: "m", parentId: null },
          { type: "custom", customType: "other-extension/entry", data: { version: 1 } },
        ],
        OWNER,
      ),
    ).toEqual({ _tag: "none" });
  });

  it("restores the newest link so a confirmed /herdr-btw:new supersedes", () => {
    const superseded = { ...LINK, childSessionId: NEW_CHILD_ID, childSessionPath: NEW_CHILD_FILE };
    expect(restoreHerdrBtwLink([linkEntry(LINK), linkEntry(superseded)], OWNER)).toEqual({
      _tag: "restored",
      link: superseded,
    });
  });

  it("ignores links copied from another parent session", () => {
    const inherited = {
      ...LINK,
      parentSessionId: "ancestor-session",
      parentSessionPath: "/sessions/ancestor.jsonl",
    };
    expect(restoreHerdrBtwLink([linkEntry(inherited)], OWNER)).toEqual({ _tag: "none" });
    expect(restoreHerdrBtwLink([linkEntry(LINK), linkEntry(inherited)], OWNER)).toEqual({
      _tag: "restored",
      link: LINK,
    });
  });

  it("fails closed on a malformed or wrong-version newest entry", () => {
    expect(restoreHerdrBtwLink([linkEntry(LINK), linkEntry({ version: 2 })], OWNER)).toEqual({
      _tag: "malformed",
    });
    expect(restoreHerdrBtwLink([linkEntry(undefined)], OWNER)).toEqual({ _tag: "malformed" });
    expect(restoreHerdrBtwLink([linkEntry("not-a-link")], OWNER)).toEqual({
      _tag: "malformed",
    });
  });
});

describe("herdr-btw reuse workflow", () => {
  it.effect("creates a new blank side session instead of adopting an inherited link", () =>
    Effect.gen(function* () {
      const inherited = {
        ...LINK,
        parentSessionId: "ancestor-session",
        parentSessionPath: "/sessions/ancestor.jsonl",
      };
      const test = fixture({ initialLinks: [inherited] });
      const result = yield* withReadiness(test.open());

      expect(result.mode).toBe("created");
      const start = test.calls.find((call) => call.operation === "start side-session Pi");
      expect(start?.args).toContain("--session");
      expect(start?.args).toContain(NEW_CHILD_FILE);
      expect(start?.args).not.toContain("--fork");
      expect(start?.args).not.toContain(CHILD_FILE);
      expect(test.recordedLinks.at(-1)).toMatchObject({
        parentSessionId: SESSION_ID,
        parentSessionPath: SESSION_FILE,
        childSessionId: NEW_CHILD_ID,
      });
    }),
  );

  it.effect("focuses the exact live BTW agent and delivers the optional prompt", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], liveAgents: [liveChildAgent()] });
      const result = yield* test.open("continue please");
      expect(result).toMatchObject({
        mode: "focused",
        agentName: LINK.agentName,
        paneId: "w1:p2",
        prompted: true,
      });
      expect(operationNames(test.calls)).toEqual([
        "inspect protocol",
        "inspect live agents",
        "prompt side-session Pi",
        "focus side-session Pi",
      ]);
      expect(test.calls.find((call) => call.operation === "prompt side-session Pi")?.args).toEqual([
        "agent",
        "prompt",
        LINK.agentName,
        "Side-session request:\ncontinue please",
      ]);
      expect(test.calls.find((call) => call.operation === "focus side-session Pi")?.args).toEqual([
        "agent",
        "focus",
        LINK.agentName,
      ]);
      // A live BTW session is never duplicated by a second writer launch.
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect("focuses without prompting when no prompt is supplied", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], liveAgents: [liveChildAgent()] });
      const result = yield* test.open();
      expect(result.prompted).toBe(false);
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
    }),
  );

  it.effect("validates the linked child file before focusing a live agent", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [liveChildAgent()],
        probes: { [CHILD_FILE]: { _tag: "invalid" } },
      });
      const result = yield* Effect.result(test.open());

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_btw_link_child_invalid");
      expect(test.calls).toEqual([]);
    }),
  );

  it.effect("fails closed when multiple live agents claim the linked child session", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [liveChildAgent(), liveChildAgent({ pane_id: "w1:p9", name: "other" })],
      });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("herdr_btw_live_agent_ambiguous");
        expect(result.failure.message).toContain("/herdr-btw:new");
      }
      expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("fails closed when the live agent identity does not match the recorded link", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [liveChildAgent({ name: "someone-elses-agent" })],
      });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_btw_live_agent_ambiguous");
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("fails closed when the live terminal identity does not match the link", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [liveChildAgent({ terminal_id: "term-other" })],
      });
      const result = yield* Effect.result(test.open());

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_btw_live_agent_ambiguous");
      expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
    }),
  );

  it.effect("resumes a closed pane with --session and the parent marker", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], startedSession: CHILD_FILE });
      const result = yield* withReadiness(test.open("resume work"));
      expect(result).toMatchObject({ mode: "resumed", paneId: "w1:p2", prompted: true });
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
        `--herdr-btw-parent=${SESSION_ID}`,
        `--herdr-btw-parent-file=${SESSION_FILE}`,
        `--herdr-btw-child-session=${CHILD_ID}`,
      ]);
      // The refreshed link keeps the same child session with new live identity.
      expect(test.recordedLinks.at(-1)).toMatchObject({
        version: 1,
        childSessionId: CHILD_ID,
        childSessionPath: CHILD_FILE,
        agentName: result.agentName,
      });
    }),
  );

  it.effect("rechecks for a live child immediately before resume startup", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgentSnapshots: [[], [liveChildAgent()]],
      });
      const result = yield* Effect.result(withReadiness(test.open()));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("herdr_btw_live_agent_race");
        expect(result.failure.paneId).toBe("w1:p2");
      }
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect(
    "fails closed instead of launching a side session when the linked child file is missing",
    () =>
      Effect.gen(function* () {
        const test = fixture({
          initialLinks: [LINK],
          probes: { [CHILD_FILE]: { _tag: "invalid" } },
        });
        const result = yield* Effect.result(test.open());
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("herdr_btw_link_child_invalid");
          expect(result.failure.message).toContain("/herdr-btw:new");
        }
        expect(operationNames(test.calls)).not.toContain("split BTW pane");
        expect(operationNames(test.calls)).not.toContain("start side-session Pi");
      }),
  );

  it.effect("fails closed when the child file was replaced or reparented", () =>
    Effect.gen(function* () {
      const replacedId = fixture({
        initialLinks: [LINK],
        probes: {
          [CHILD_FILE]: {
            _tag: "valid",
            header: { id: "different-id" },
          },
        },
      });
      const reparented = fixture({
        initialLinks: [LINK],
        probes: {
          [CHILD_FILE]: {
            _tag: "valid",
            header: { id: CHILD_ID, parentSession: "/sessions/other-parent.jsonl" },
          },
        },
      });
      for (const test of [replacedId, reparented]) {
        const result = yield* Effect.result(test.open());
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.code).toBe("herdr_btw_link_child_invalid");
        expect(operationNames(test.calls)).not.toContain("split BTW pane");
      }
    }),
  );

  it.effect("rejects malformed parent and child session IDs before any Herdr call", () =>
    Effect.gen(function* () {
      const invalidParent = fixture({ sessionId: "bad session id" });
      const parentResult = yield* Effect.result(invalidParent.open());
      expect(parentResult._tag).toBe("Failure");
      expect(invalidParent.calls).toEqual([]);

      const invalidChild = fixture({ createdChildId: "bad child id" });
      const childResult = yield* Effect.result(invalidChild.open());
      expect(childResult._tag).toBe("Failure");
      expect(invalidChild.calls).toEqual([]);
    }),
  );

  it.effect("fails closed before any CLI call when the recorded link is malformed", () =>
    Effect.gen(function* () {
      const test = fixture({ restoreOverride: { _tag: "malformed" } });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("herdr_btw_link_malformed");
        expect(result.failure.message).toContain("/herdr-btw:new");
      }
      expect(test.calls).toEqual([]);
    }),
  );

  it.effect("openNew always creates a fresh BTW session and supersedes the link on success", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], liveAgents: [liveChildAgent()] });
      const result = yield* withReadiness(test.openNew("fresh BTW session"));
      expect(result.mode).toBe("created");
      // The live linked agent is not consulted and the old pane is untouched.
      expect(operationNames(test.calls)).not.toContain("inspect live agents");
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
      const start = test.calls.find((call) => call.operation === "start side-session Pi");
      expect(start?.args).not.toContain("--fork");
      expect(start?.args).toContain("--session");
      expect(start?.args).toContain(NEW_CHILD_FILE);
      expect(start?.args).toContain(`--herdr-btw-parent-file=${SESSION_FILE}`);
      expect(test.recordedLinks.at(-1)).toMatchObject({
        childSessionId: NEW_CHILD_ID,
        childSessionPath: NEW_CHILD_FILE,
      });
    }),
  );

  it.effect("a failed openNew keeps the prior link authoritative", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], failOperation: "start side-session Pi" });
      const result = yield* Effect.result(withReadiness(test.openNew()));
      expect(result._tag).toBe("Failure");
      expect(test.recordedLinks).toEqual([LINK]);
      expect(test.linkStore.restore()).toEqual({ _tag: "restored", link: LINK });
    }),
  );

  it.effect("keeps a confirmed new side session authoritative if later handoff fails", () =>
    Effect.gen(function* () {
      for (const failure of ["prompt side-session Pi", "focus side-session Pi"]) {
        const test = fixture({ initialLinks: [LINK], failOperation: failure });
        const prompt = failure === "prompt side-session Pi" ? "question" : undefined;
        const result = yield* Effect.result(withReadiness(test.openNew(prompt)));

        expect(result._tag).toBe("Failure");
        expect(test.recordedLinks.at(-1)).toMatchObject({
          parentSessionId: SESSION_ID,
          childSessionId: NEW_CHILD_ID,
          childSessionPath: NEW_CHILD_FILE,
        });
      }
    }),
  );

  it.effect("a failed link append after startup is a typed retained-pane failure", () =>
    Effect.gen(function* () {
      const test = fixture({ recordFails: true });
      const result = yield* Effect.result(withReadiness(test.open()));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_btw_link_record_failed",
          paneId: "w1:p2",
        });
      expect(test.calls.some((call) => call.args.includes("close"))).toBe(false);
    }),
  );

  it.effect("serializes concurrent commands so only one launch can occur", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const test = fixture({ holdStart: hold, startedSession: NEW_CHILD_FILE });
      const service = yield* test.makeService;
      const first = yield* service
        .open("first")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const second = yield* service
        .open("second")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      for (let step = 0; step < 40; step += 1) yield* TestClock.adjust("500 millis");
      yield* Deferred.succeed(hold, undefined);
      for (let step = 0; step < 40; step += 1) yield* TestClock.adjust("500 millis");
      const firstResult = yield* Fiber.join(first);
      const secondResult = yield* Fiber.join(second);
      expect(firstResult.mode).toBe("created");
      // The second command reuses the recorded link's live agent, never a duplicate writer.
      expect(secondResult.mode).toBe("focused");
      expect(test.calls.filter((call) => call.operation === "start side-session Pi")).toHaveLength(
        1,
      );
      expect(test.calls.filter((call) => call.operation === "split BTW pane")).toHaveLength(1);
      expect(test.recordedLinks).toHaveLength(1);
    }),
  );
});
