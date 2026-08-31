import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import {
  HerdrClient,
  type HerdrClientContract,
  type HerdrStartSideSessionInput,
} from "../src/boundary/herdr-client.ts";
import type {
  HerdrBtwLinkRecord,
  HerdrBtwLinkRecordResult,
  HerdrBtwLinkStore,
} from "../src/boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "../src/boundary/host-session.ts";
import type {
  SessionFileIdentityComparator,
  SessionHeaderProbe,
} from "../src/boundary/session-file.ts";
import {
  HERDR_BTW_LINK_ENTRY_TYPE,
  restoreHerdrBtwLink,
  type HerdrBtwLink,
  type HerdrBtwLinkRestoration,
} from "../src/btw/link.ts";
import { makeHerdrBtwService } from "../src/btw/service.ts";
import {
  makeHerdrBtwCallRecorder,
  operationInputs,
  operationNames,
  withShellReadiness as withReadiness,
} from "./fixtures/herdr-btw-harness.ts";

const SESSION_FILE = "/sessions/parent.jsonl";
const SESSION_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const CHILD_ID = "0198aaaa-7564-4c88-8b67-child0btw001";
const CHILD_FILE = "/sessions/child.jsonl";
const NEW_CHILD_ID = "0198bbbb-7564-4c88-8b67-child0btw002";
const NEW_CHILD_FILE = "/sessions/child-new.jsonl";
const CHILD_ALIAS = "/sessions/aliases/../child.jsonl";
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
  readonly agent?: string;
  readonly name?: string;
  readonly agent_session?:
    | {
        readonly source: string;
        readonly agent: string;
        readonly kind: "id" | "path";
        readonly value: string;
      }
    | null
    | undefined;
}

const liveChildAgent = (overrides: SnapshotAgentOverrides = {}) => ({
  pane_id: "w1:p2",
  terminal_id: "term-btw",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "pi",
  name: LINK.agentName,
  agent_session: { source: "herdr:pi", agent: "pi", kind: "path" as const, value: CHILD_FILE },
  ...overrides,
});

interface FixtureOptions {
  readonly initialLinks?: ReadonlyArray<HerdrBtwLink>;
  readonly restoreOverride?: HerdrBtwLinkRestoration;
  readonly liveAgents?: ReadonlyArray<ReturnType<typeof liveChildAgent>>;
  readonly liveAgentSnapshots?: ReadonlyArray<ReadonlyArray<ReturnType<typeof liveChildAgent>>>;
  readonly probes?: Readonly<Record<string, SessionHeaderProbe>>;
  readonly compareSessionFileIdentity?: SessionFileIdentityComparator;
  readonly recordResult?: HerdrBtwLinkRecordResult;
  readonly failOperation?: string;
  readonly startedSession?: string;
  readonly createdChildId?: string;
  readonly sessionId?: string;
  readonly holdStart?: Deferred.Deferred<void>;
}

const fixture = (options: FixtureOptions = {}) => {
  const { calls, run, runEffect } = makeHerdrBtwCallRecorder(options.failOperation);
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

  const client = HerdrClient.of({
    inspectProtocol: () => run("inspect protocol", undefined, () => 20),
    inspectPiIntegration: () => run("inspect Pi integration", undefined, () => true),
    inspectLiveAgents: () =>
      run(
        "inspect live agents",
        undefined,
        () =>
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
      ),
    resolveCallingPane: () => run("resolve calling pane", undefined, () => parentPane),
    inspectPaneLayout: (paneId) =>
      run("inspect calling pane layout", { paneId }, () => ({
        workspace_id: "w1",
        tab_id: "w1:t1",
        area: { width: 160, height: 40 },
      })),
    splitPane: (input) => run("split BTW pane", input, () => btwPane),
    inspectPaneProcessInfo: (paneId) =>
      run("inspect BTW pane shell", { paneId }, () => ({
        pane_id: btwPane.pane_id,
        shell_pid: 4242,
        foreground_process_group_id: 4242,
        foreground_processes: [{ pid: 4242, name: "zsh" }],
      })),
    startSideSessionPi: (input) =>
      runEffect("start side-session Pi", input, () => {
        const started = Effect.sync(() => {
          startedAgentName = input.agentName;
          startedSessionValue = options.startedSession ?? input.childSessionPath;
          return {
            ...btwPane,
            agent: "pi",
            name: input.agentName,
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "path" as const,
              value: startedSessionValue,
            },
          };
        });
        return options.holdStart === undefined
          ? started
          : Effect.flatMap(Deferred.await(options.holdStart), () => started);
      }),
    promptSideSessionPi: (agentName, prompt) =>
      run("prompt side-session Pi", { agentName, prompt }, () => undefined),
    focusSideSessionPi: (agentName) => run("focus side-session Pi", { agentName }, () => undefined),
  } satisfies HerdrClientContract);

  const input: HerdrBtwSessionInput = {
    environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    cwd: CWD,
    sessionFile: SESSION_FILE,
    sessionId: options.sessionId ?? SESSION_ID,
    sessionDir: "/sessions",
  };
  const recordedLinks: HerdrBtwLink[] = [...(options.initialLinks ?? [])];
  const recordAttempts: HerdrBtwLinkRecord[] = [];
  let restoreCount = 0;
  const linkStore: HerdrBtwLinkStore = {
    restore: () => {
      restoreCount += 1;
      if (options.restoreOverride) return options.restoreOverride;
      const link = recordedLinks.at(-1);
      return link === undefined ? { _tag: "none" } : { _tag: "restored", link };
    },
    record: (link) => {
      recordAttempts.push(link);
      const result = options.recordResult ?? "recorded";
      if (result !== "recorded") return result;
      recordedLinks.push({
        version: 1,
        parentSessionId: SESSION_ID,
        parentSessionPath: SESSION_FILE,
        ...link,
      });
      return result;
    },
  };
  const probeFor = (path: string): SessionHeaderProbe => {
    const override = options.probes?.[path];
    if (override) return override;
    if (path === SESSION_FILE)
      return { _tag: "valid", header: { id: options.sessionId ?? SESSION_ID } };
    if (path === CHILD_FILE) return { _tag: "valid", header: { id: CHILD_ID } };
    if (path === NEW_CHILD_FILE) return { _tag: "valid", header: { id: NEW_CHILD_ID } };
    return { _tag: "invalid" };
  };
  const makeService = makeHerdrBtwService(input, linkStore, {
    probeSessionHeader: probeFor,
    compareSessionFileIdentity:
      options.compareSessionFileIdentity ??
      ((leftPath, rightPath) => (leftPath === rightPath ? "same" : "distinct")),
    createChildSessionId: () => options.createdChildId ?? NEW_CHILD_ID,
    createBlankChildSessionFile: () => Effect.succeed({ _tag: "created", path: NEW_CHILD_FILE }),
  }).pipe(Effect.provideService(HerdrClient, client));
  const open = (prompt?: string | undefined) =>
    Effect.flatMap(makeService, (service) => service.open(prompt));
  const openNew = (prompt?: string | undefined) =>
    Effect.flatMap(makeService, (service) => service.openNew(prompt));

  return {
    calls,
    linkStore,
    makeService,
    open,
    openNew,
    recordAttempts,
    recordedLinks,
    restoreCount: () => restoreCount,
  };
};

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

  it("restores the newest owner link", () => {
    const superseded = { ...LINK, childSessionId: NEW_CHILD_ID, childSessionPath: NEW_CHILD_FILE };
    expect(restoreHerdrBtwLink([linkEntry(LINK), linkEntry(superseded)], OWNER)).toEqual({
      _tag: "restored",
      link: superseded,
    });
  });

  it("filters copied ancestor links at the store contract boundary", () => {
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
    expect(restoreHerdrBtwLink([linkEntry("not-a-link")], OWNER)).toEqual({ _tag: "malformed" });
  });
});

describe("herdr-btw reuse workflow", () => {
  it.effect("focuses the exact live agent and delivers the optional prompt", () =>
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
      expect(operationInputs(test.calls, "prompt side-session Pi")[0]).toEqual({
        agentName: LINK.agentName,
        prompt: "Side-session request:\ncontinue please",
      });
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

  it.effect("focuses exact ID metadata for the recorded child", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [
          liveChildAgent({
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "id",
              value: CHILD_ID,
            },
          }),
        ],
      });

      expect(yield* test.open()).toMatchObject({ mode: "focused", paneId: "w1:p2" });
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("focuses a path alias with the recorded filesystem identity", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [
          liveChildAgent({
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "path",
              value: CHILD_ALIAS,
            },
          }),
        ],
        compareSessionFileIdentity: (leftPath, rightPath) =>
          [leftPath, rightPath].every((path) => path === CHILD_FILE || path === CHILD_ALIAS)
            ? "same"
            : leftPath === rightPath
              ? "same"
              : "distinct",
      });

      expect(yield* test.open()).toMatchObject({ mode: "focused", paneId: "w1:p2" });
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("validates the child file before focusing a live agent", () =>
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

  it.effect("treats matching child ID metadata as a conflict despite another name", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [
          liveChildAgent({
            name: "another-agent",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "id",
              value: CHILD_ID,
            },
          }),
        ],
      });
      const result = yield* Effect.result(test.open());

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_btw_live_agent_ambiguous");
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("treats unavailable path identity as a conflict, never as distinct", () =>
    Effect.gen(function* () {
      const unavailablePath = "/sessions/missing-child.jsonl";
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [
          liveChildAgent({
            name: "another-agent",
            agent_session: {
              source: "herdr:pi",
              agent: "pi",
              kind: "path",
              value: unavailablePath,
            },
          }),
        ],
        compareSessionFileIdentity: (leftPath, rightPath) =>
          leftPath === unavailablePath || rightPath === unavailablePath
            ? "unavailable"
            : leftPath === rightPath
              ? "same"
              : "distinct",
      });
      const result = yield* Effect.result(test.open());

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_btw_live_agent_ambiguous");
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("fails closed when multiple live agents claim the child session", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [liveChildAgent(), liveChildAgent({ pane_id: "w1:p9", name: "other" })],
      });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_btw_live_agent_ambiguous",
          outcome: "confirmed",
        });
      expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("requires exact name, terminal, Pi, and child identity before focus", () =>
    Effect.gen(function* () {
      for (const live of [
        liveChildAgent({ name: "someone-elses-agent" }),
        liveChildAgent({ terminal_id: "term-other" }),
        liveChildAgent({ agent: "claude" }),
        liveChildAgent({
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "path",
            value: NEW_CHILD_FILE,
          },
        }),
        liveChildAgent({ agent_session: undefined }),
      ]) {
        const test = fixture({ initialLinks: [LINK], liveAgents: [live] });
        const result = yield* Effect.result(test.open());
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.code).toBe("herdr_btw_live_agent_ambiguous");
        expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
        expect(operationNames(test.calls)).not.toContain("split BTW pane");
      }
    }),
  );

  it.effect("resumes a closed child with the semantic launch identity", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], startedSession: CHILD_FILE });
      const result = yield* withReadiness(test.open("resume work"));
      expect(result).toMatchObject({ mode: "resumed", paneId: "w1:p2", prompted: true });
      expect(
        operationInputs<HerdrStartSideSessionInput>(test.calls, "start side-session Pi")[0],
      ).toEqual({
        agentName: result.agentName,
        paneId: "w1:p2",
        childSessionId: CHILD_ID,
        childSessionPath: CHILD_FILE,
        parentSessionId: SESSION_ID,
        parentSessionPath: SESSION_FILE,
        displayName: undefined,
      });
      expect(test.recordedLinks.at(-1)).toMatchObject({
        version: 1,
        childSessionId: CHILD_ID,
        childSessionPath: CHILD_FILE,
        agentName: result.agentName,
      });
    }),
  );

  it.effect("takes a second snapshot immediately before resume startup", () =>
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
      expect(
        operationNames(test.calls).filter((name) => name === "inspect live agents"),
      ).toHaveLength(2);
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect("treats matching child ID metadata as a pre-start conflict", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgentSnapshots: [
          [],
          [
            liveChildAgent({
              name: "another-agent",
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "id",
                value: CHILD_ID,
              },
            }),
          ],
        ],
      });
      const result = yield* Effect.result(withReadiness(test.open()));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_btw_live_agent_race",
          outcome: "confirmed",
          paneId: "w1:p2",
        });
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect("treats the recorded name as a pre-start conflict with wrong session metadata", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgentSnapshots: [
          [],
          [
            liveChildAgent({
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "path",
                value: NEW_CHILD_FILE,
              },
            }),
          ],
        ],
      });
      const result = yield* Effect.result(withReadiness(test.open()));

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_btw_live_agent_race",
          outcome: "confirmed",
          paneId: "w1:p2",
        });
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect("rejects a linked child that aliases its parent before Herdr inspection", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        compareSessionFileIdentity: (leftPath, rightPath) =>
          [leftPath, rightPath].every((path) => path === CHILD_FILE || path === SESSION_FILE)
            ? "same"
            : leftPath === rightPath
              ? "same"
              : "distinct",
      });
      const result = yield* Effect.result(test.open());

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_btw_link_child_invalid");
      expect(test.calls).toEqual([]);
    }),
  );

  it.effect("fails closed when the linked child is missing, replaced, or reparented", () =>
    Effect.gen(function* () {
      const cases = [
        { _tag: "invalid" as const },
        { _tag: "valid" as const, header: { id: "different-id" } },
        {
          _tag: "valid" as const,
          header: { id: CHILD_ID, parentSession: "/sessions/other-parent.jsonl" },
        },
      ];
      for (const probe of cases) {
        const test = fixture({ initialLinks: [LINK], probes: { [CHILD_FILE]: probe } });
        const result = yield* Effect.result(test.open());
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            code: "herdr_btw_link_child_invalid",
            outcome: "confirmed",
          });
        expect(operationNames(test.calls)).not.toContain("split BTW pane");
      }
    }),
  );

  it.effect("rejects malformed parent and child IDs before any client call", () =>
    Effect.gen(function* () {
      const invalidParent = fixture({ sessionId: "bad session id" });
      expect((yield* Effect.result(invalidParent.open()))._tag).toBe("Failure");
      expect(invalidParent.calls).toEqual([]);

      const invalidChild = fixture({ createdChildId: "bad child id" });
      expect((yield* Effect.result(invalidChild.open()))._tag).toBe("Failure");
      expect(invalidChild.calls).toEqual([]);
    }),
  );

  it.effect("fails closed before client calls when the recorded link is malformed", () =>
    Effect.gen(function* () {
      const test = fixture({ restoreOverride: { _tag: "malformed" } });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_btw_link_malformed",
          outcome: "confirmed",
        });
      expect(test.calls).toEqual([]);
    }),
  );

  it.effect("accepts path-based startup evidence for the same child filesystem identity", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        startedSession: CHILD_ALIAS,
        compareSessionFileIdentity: (leftPath, rightPath) =>
          [leftPath, rightPath].every((path) => path === CHILD_FILE || path === CHILD_ALIAS)
            ? "same"
            : leftPath === rightPath
              ? "same"
              : "distinct",
      });

      expect(yield* withReadiness(test.open())).toMatchObject({ mode: "resumed" });
      expect(test.recordedLinks.at(-1)?.childSessionPath).toBe(CHILD_FILE);
    }),
  );

  it.effect("openNew creates a fresh child and supersedes only after startup validation", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], liveAgents: [liveChildAgent()] });
      const result = yield* withReadiness(test.openNew("fresh BTW session"));
      expect(result.mode).toBe("created");
      expect(operationNames(test.calls)).not.toContain("inspect live agents");
      expect(
        operationInputs<HerdrStartSideSessionInput>(test.calls, "start side-session Pi")[0],
      ).toMatchObject({
        childSessionId: NEW_CHILD_ID,
        childSessionPath: NEW_CHILD_FILE,
        parentSessionPath: SESSION_FILE,
      });
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
      expect(
        operationNames(test.calls).filter((name) => name === "start side-session Pi"),
      ).toHaveLength(1);
    }),
  );

  it.effect("keeps the new link authoritative if prompt or focus handoff fails", () =>
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

  it.effect("focus follows prompt settlement even when prompt outcome is uncertain", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [liveChildAgent()],
        failOperation: "prompt side-session Pi",
      });
      const result = yield* Effect.result(test.open("question"));
      expect(result._tag).toBe("Failure");
      expect(operationNames(test.calls).slice(-2)).toEqual([
        "prompt side-session Pi",
        "focus side-session Pi",
      ]);
    }),
  );

  it.effect("reports a refused link record as a confirmed retained-pane failure", () =>
    Effect.gen(function* () {
      const test = fixture({ recordResult: "refused" });
      const result = yield* Effect.result(withReadiness(test.openNew()));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          code: "herdr_btw_link_record_refused",
          outcome: "confirmed",
          paneId: "w1:p2",
        });
        expect(result.failure.message).toContain("was not recorded");
      }
      expect(test.recordAttempts).toHaveLength(1);
      expect(test.restoreCount()).toBe(0);
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
      expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
      expect(
        operationNames(test.calls).filter((name) => name === "start side-session Pi"),
      ).toHaveLength(1);
    }),
  );

  it.effect("does not reread or retry after an uncertain link append", () =>
    Effect.gen(function* () {
      const test = fixture({ recordResult: "uncertain" });
      const result = yield* Effect.result(withReadiness(test.openNew("do not deliver")));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          code: "herdr_btw_link_record_outcome_uncertain",
          outcome: "uncertain",
          paneId: "w1:p2",
        });
        expect(result.failure.message).toContain("may have been recorded");
        expect(result.failure.message).toContain("Do not retry");
        expect(result.failure.message).toContain("Pane w1:p2 was retained");
      }
      expect(test.recordAttempts).toHaveLength(1);
      expect(test.restoreCount()).toBe(0);
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
      expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
      expect(
        operationNames(test.calls).filter((name) => name === "start side-session Pi"),
      ).toHaveLength(1);
    }),
  );

  it.effect("serializes concurrent commands so only one launch occurs", () =>
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
      expect(secondResult.mode).toBe("focused");
      expect(
        operationNames(test.calls).filter((name) => name === "start side-session Pi"),
      ).toHaveLength(1);
      expect(operationNames(test.calls).filter((name) => name === "split BTW pane")).toHaveLength(
        1,
      );
      expect(test.recordedLinks).toHaveLength(1);
    }),
  );
});
