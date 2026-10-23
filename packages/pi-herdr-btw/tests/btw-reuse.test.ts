import { describe, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { makeHerdrClient, type HerdrPane } from "../src/boundary/herdr-client.ts";
import { SessionHeaderProbe } from "../src/boundary/session-file.ts";
import {
  HERDR_BTW_LINK_ENTRY_TYPE,
  HerdrBtwLinkRestoration,
  restoreHerdrBtwLink,
  type HerdrBtwLink,
} from "../src/btw/link.ts";
import {
  CHILD_FILE,
  CHILD_ID,
  makeServiceFixture,
  operationCount,
  operationInputs,
  operationNames,
  SESSION_FILE,
  SESSION_ID,
  withShellReadiness as withReadiness,
  type HerdrBtwFixtureOptions,
  aliasIdentity,
} from "./fixtures/herdr-btw-harness.ts";

const NEW_CHILD_ID = "0198bbbb-7564-4c88-8b67-child0btw002";
const NEW_CHILD_FILE = "/sessions/child-new.jsonl";

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

const liveChildAgent = (overrides: Partial<HerdrPane> = {}) => ({
  pane_id: "w1:p2",
  terminal_id: "term-btw",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "pi",
  name: LINK.agentName,
  agent_session: { source: "herdr:pi", agent: "pi", kind: "path" as const, value: CHILD_FILE },
  ...overrides,
});

/** Decodes the given `herdr api snapshot` output with the real client. */
const snapshotOutputClient = (stdout: string) =>
  makeHerdrClient(
    {},
    {
      processRunner: () =>
        Effect.succeed({
          code: 0,
          signal: null,
          stdout,
          stderr: "",
          overflowed: false,
          timedOut: false,
          cleanupUnconfirmed: false,
        }),
    },
  );

const fixture = (options: HerdrBtwFixtureOptions = {}) =>
  makeServiceFixture({
    createdChildId: NEW_CHILD_ID,
    createdChildFile: NEW_CHILD_FILE,
    ...options,
  });

const linkEntry = (data: HerdrBtwLink | { readonly version: number } | string | undefined) => ({
  type: "custom",
  id: "e1",
  parentId: null,
  timestamp: "2026-08-26T00:00:00.000Z",
  customType: HERDR_BTW_LINK_ENTRY_TYPE,
  data,
});

describe("herdr-btw link restoration", () => {
  it("filters copied ancestor links at the store contract boundary", () => {
    const inherited = {
      ...LINK,
      parentSessionId: "ancestor-session",
      parentSessionPath: "/sessions/ancestor.jsonl",
    };
    expect(restoreHerdrBtwLink([linkEntry(inherited)], OWNER)).toEqual(
      HerdrBtwLinkRestoration.none(),
    );
    expect(restoreHerdrBtwLink([linkEntry(LINK), linkEntry(inherited)], OWNER)).toEqual(
      HerdrBtwLinkRestoration.restored({ link: LINK }),
    );
  });

  it("lets the newest owned or unreadable link entry decide", () => {
    const replacement = { ...LINK, agentName: "btw-replacement", terminalId: "term-replacement" };
    const unreadable = linkEntry({ version: 2 });
    const truncated = linkEntry({ ...LINK, terminalId: undefined });
    for (const [entries, expected] of [
      [[], HerdrBtwLinkRestoration.none()],
      [
        [linkEntry(LINK), linkEntry(replacement)],
        HerdrBtwLinkRestoration.restored({ link: replacement }),
      ],
      [[unreadable, linkEntry(LINK)], HerdrBtwLinkRestoration.restored({ link: LINK })],
      [[linkEntry(LINK), unreadable], HerdrBtwLinkRestoration.malformed()],
      [[linkEntry(LINK), truncated], HerdrBtwLinkRestoration.malformed()],
      [
        [unreadable, linkEntry({ ...LINK, parentSessionId: "ancestor-session" })],
        HerdrBtwLinkRestoration.malformed(),
      ],
    ] as const)
      expect(restoreHerdrBtwLink(entries, OWNER)).toEqual(expected);
  });
});

describe("herdr-btw reuse workflow", () => {
  it.effect("focuses the exact live agent and delivers the optional prompt", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], liveAgents: [liveChildAgent()] });
      const result = yield* test.open("continue please");
      expect(result).toMatchObject({ mode: "focused", agentName: LINK.agentName, paneId: "w1:p2" });
      expect(operationNames(test.calls)).toEqual([
        "inspect live agents",
        "prompt side-session Pi",
        "focus side-session Pi",
      ]);
      expect(operationInputs(test.calls, "prompt side-session Pi")[0]).toEqual({
        agentName: LINK.agentName,
        prompt: "Side-session request:\ncontinue please",
      });
    }),
  );

  it.effect("refuses an outdated live Herdr before focusing or relaunching the child", () =>
    Effect.gen(function* () {
      for (const liveAgents of [[liveChildAgent()], []]) {
        const test = fixture({ initialLinks: [LINK], liveAgents, protocol: 16 });
        expect(yield* Effect.flip(test.open())).toMatchObject({
          code: "herdr_upgrade_required",
          outcome: "confirmed",
        });
        expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
        expect(operationNames(test.calls)).not.toContain("split BTW pane");
      }
    }),
  );

  it.effect("reports an outdated Herdr even when its snapshot's agents don't decode", () =>
    Effect.gen(function* () {
      for (const agents of [[{ ...liveChildAgent(), terminal_id: "" }], "legacy agents"]) {
        const liveSnapshot = (protocol: number) =>
          fixture({
            initialLinks: [LINK],
            inspectLiveAgents: snapshotOutputClient(
              JSON.stringify({ result: { snapshot: { protocol, agents } } }),
            ).inspectLiveAgents,
          });
        const outdated = liveSnapshot(16);
        expect(yield* Effect.flip(outdated.open())).toMatchObject({
          code: "herdr_upgrade_required",
          outcome: "confirmed",
        });
        expect(operationNames(outdated.calls)).not.toContain("split BTW pane");
        expect(yield* Effect.flip(liveSnapshot(20).open())).toMatchObject({
          code: "herdr_inspect_live_agents_protocol_invalid",
          outcome: "confirmed",
        });
      }
    }),
  );

  for (const [name, options] of [
    [
      "multiple agents claiming the child",
      { liveAgents: [liveChildAgent(), liveChildAgent({ pane_id: "w1:p9", name: "other" })] },
    ],
  ] satisfies Array<[string, HerdrBtwFixtureOptions]>) {
    it.effect(`refuses focus or duplicate startup for ${name}`, () =>
      Effect.gen(function* () {
        const test = fixture({ initialLinks: [LINK], ...options });
        expect(yield* Effect.flip(test.open())).toMatchObject({
          code: "herdr_btw_live_agent_ambiguous",
          outcome: "confirmed",
        });
        expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
        expect(operationNames(test.calls)).not.toContain("split BTW pane");
      }),
    );
  }

  it.effect("resumes a closed child with the semantic launch identity", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], startedSession: CHILD_FILE });
      const result = yield* withReadiness(test.open("resume work"));
      expect(result).toMatchObject({ mode: "resumed", paneId: "w1:p2" });
      expect(operationInputs(test.calls, "start side-session Pi")[0]).toEqual({
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

  it.effect("revalidates the child file after preparation before resuming Pi", () =>
    Effect.gen(function* () {
      for (const replacement of ["missing", "different-session", "parent-alias"] as const) {
        const probes: Record<string, SessionHeaderProbe> = {};
        let replaced = false;
        const test = fixture({
          initialLinks: [LINK],
          startedSession: CHILD_FILE,
          probes,
          onLiveAgentSnapshot: (index) => {
            if (index !== 1) return;
            replaced = true;
            if (replacement !== "parent-alias")
              probes[CHILD_FILE] =
                replacement === "missing"
                  ? SessionHeaderProbe.invalid()
                  : SessionHeaderProbe.valid({ header: { id: "replacement-session" } });
          },
          compareSessionFileIdentity: (left, right) =>
            replaced &&
            replacement === "parent-alias" &&
            Arr.every([left, right], (path) => path === CHILD_FILE || path === SESSION_FILE)
              ? "same"
              : left === right
                ? "same"
                : "distinct",
        });
        yield* Effect.flip(withReadiness(test.open()));
        expect(operationNames(test.calls)).not.toContain("start side-session Pi");
        expect(test.recordedLinks).toEqual([LINK]);
      }
    }),
  );

  for (const [name, live] of [["the exact live child", liveChildAgent()]] as const) {
    it.effect(`the second pre-start snapshot rejects ${name}`, () =>
      Effect.gen(function* () {
        const test = fixture({ initialLinks: [LINK], liveAgentSnapshots: [[], [live]] });
        expect(yield* Effect.flip(withReadiness(test.open()))).toMatchObject({
          code: "herdr_btw_live_agent_race",
          outcome: "confirmed",
          paneId: "w1:p2",
        });
        expect(operationNames(test.calls)).not.toContain("start side-session Pi");
      }),
    );
  }

  it.effect("fails closed before any Herdr call on an invalid, reparented or aliased child", () =>
    Effect.gen(function* () {
      for (const options of [
        { probes: { [CHILD_FILE]: SessionHeaderProbe.invalid() } },
        { probes: { [CHILD_FILE]: SessionHeaderProbe.valid({ header: { id: "different-id" } }) } },
        {
          probes: {
            [CHILD_FILE]: SessionHeaderProbe.valid({
              header: { id: CHILD_ID, parentSession: "/sessions/other-parent.jsonl" },
            }),
          },
        },
        { compareSessionFileIdentity: aliasIdentity([CHILD_FILE, SESSION_FILE]) },
      ] satisfies HerdrBtwFixtureOptions[]) {
        const test = fixture({ initialLinks: [LINK], liveAgents: [liveChildAgent()], ...options });
        expect(yield* Effect.flip(test.open())).toMatchObject({
          code: "herdr_btw_link_child_invalid",
          outcome: "confirmed",
        });
        expect(test.calls).toEqual([]);
      }
    }),
  );

  it.effect("a failed openNew keeps the prior link authoritative", () =>
    Effect.gen(function* () {
      const test = fixture({ initialLinks: [LINK], failOperation: "start side-session Pi" });
      yield* Effect.flip(withReadiness(test.openNew()));
      expect(test.recordedLinks).toEqual([LINK]);
      expect(operationCount(test.calls, "start side-session Pi")).toBe(1);
    }),
  );

  it.effect("keeps the new link authoritative if prompt or focus handoff fails", () =>
    Effect.gen(function* () {
      for (const failure of ["prompt side-session Pi", "focus side-session Pi"]) {
        const test = fixture({ initialLinks: [LINK], failOperation: failure });
        const prompt = failure === "prompt side-session Pi" ? "question" : undefined;
        const error = yield* Effect.flip(withReadiness(test.openNew(prompt)));

        expect(error).toMatchObject({ outcome: "uncertain", paneId: "w1:p2" });
        expect(test.recordedLinks.at(-1)).toMatchObject({
          parentSessionId: SESSION_ID,
          childSessionId: NEW_CHILD_ID,
          childSessionPath: NEW_CHILD_FILE,
        });
      }
    }),
  );

  for (const [recordResult, code, outcome] of [
    ["refused", "herdr_btw_link_record_refused", "confirmed"],
    ["uncertain", "herdr_btw_link_record_outcome_uncertain", "uncertain"],
  ] as const) {
    it.effect(`does not reread, retry or hand off after a ${recordResult} link record`, () =>
      Effect.gen(function* () {
        const test = fixture({ recordResult });
        const error = yield* Effect.flip(withReadiness(test.openNew("do not deliver")));
        expect(error).toMatchObject({ code, outcome, paneId: "w1:p2" });
        expect(test.recordAttempts).toHaveLength(1);
        expect(test.restoreCount()).toBe(0);
        expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
        expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
        expect(operationCount(test.calls, "start side-session Pi")).toBe(1);
      }),
    );
  }

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
      expect(operationCount(test.calls, "start side-session Pi")).toBe(1);
      expect(operationCount(test.calls, "split BTW pane")).toBe(1);
      expect(test.recordedLinks).toHaveLength(1);
    }),
  );
});
