import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { type HerdrPane, type HerdrStartSideSessionInput } from "../src/boundary/herdr-client.ts";
import {
  HERDR_BTW_LINK_ENTRY_TYPE,
  restoreHerdrBtwLink,
  type HerdrBtwLink,
} from "../src/btw/link.ts";
import {
  makeServiceFixture,
  operationCount,
  operationInputs,
  operationNames,
  withShellReadiness as withReadiness,
  type HerdrBtwFixtureOptions,
  aliasIdentity,
} from "./fixtures/herdr-btw-harness.ts";

const SESSION_FILE = "/sessions/parent.jsonl";
const SESSION_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const CHILD_ID = "0198aaaa-7564-4c88-8b67-child0btw001";
const CHILD_FILE = "/sessions/child.jsonl";
const NEW_CHILD_ID = "0198bbbb-7564-4c88-8b67-child0btw002";
const NEW_CHILD_FILE = "/sessions/child-new.jsonl";
const CHILD_ALIAS = "/sessions/aliases/../child.jsonl";

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

const fixture = (options: HerdrBtwFixtureOptions = {}) =>
  makeServiceFixture({
    protocol: 20,
    createdChildId: NEW_CHILD_ID,
    createdChildFile: NEW_CHILD_FILE,
    ...options,
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
      expect(result).toMatchObject({ mode: "focused", agentName: LINK.agentName, paneId: "w1:p2" });
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
      yield* test.open();
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
    }),
  );

  for (const [name, kind, value, options] of [
    ["exact ID metadata", "id", CHILD_ID, {}],
    [
      "a path alias",
      "path",
      CHILD_ALIAS,
      { compareSessionFileIdentity: aliasIdentity([CHILD_FILE, CHILD_ALIAS]) },
    ],
  ] as const) {
    it.effect(`focuses ${name} with the recorded child identity`, () =>
      Effect.gen(function* () {
        const test = fixture({
          initialLinks: [LINK],
          liveAgents: [
            liveChildAgent({ agent_session: { source: "herdr:pi", agent: "pi", kind, value } }),
          ],
          ...options,
        });

        expect(yield* test.open()).toMatchObject({ mode: "focused", paneId: "w1:p2" });
        expect(operationNames(test.calls)).not.toContain("split BTW pane");
      }),
    );
  }

  const unavailablePath = "/sessions/missing-child.jsonl";
  for (const [name, options] of [
    [
      "matching child ID metadata under another name",
      {
        liveAgents: [
          liveChildAgent({
            name: "another-agent",
            agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: CHILD_ID },
          }),
        ],
      },
    ],
    [
      "unavailable path identity",
      {
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
      },
    ],
    [
      "multiple agents claiming the child",
      { liveAgents: [liveChildAgent(), liveChildAgent({ pane_id: "w1:p9", name: "other" })] },
    ],
    ["another name", { liveAgents: [liveChildAgent({ name: "someone-elses-agent" })] }],
    ["another terminal", { liveAgents: [liveChildAgent({ terminal_id: "term-other" })] }],
    ["a non-Pi agent", { liveAgents: [liveChildAgent({ agent: "claude" })] }],
    [
      "another child path",
      {
        liveAgents: [
          liveChildAgent({
            agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: NEW_CHILD_FILE },
          }),
        ],
      },
    ],
    ["missing session metadata", { liveAgents: [liveChildAgent({ agent_session: undefined })] }],
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

  for (const [name, live] of [
    ["the exact live child", liveChildAgent()],
    [
      "matching child ID metadata under another name",
      liveChildAgent({
        name: "another-agent",
        agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: CHILD_ID },
      }),
    ],
    [
      "the recorded name with wrong session metadata",
      liveChildAgent({
        agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: NEW_CHILD_FILE },
      }),
    ],
  ] as const) {
    it.effect(`the second pre-start snapshot rejects ${name}`, () =>
      Effect.gen(function* () {
        const test = fixture({ initialLinks: [LINK], liveAgentSnapshots: [[], [live]] });
        expect(yield* Effect.flip(withReadiness(test.open()))).toMatchObject({
          code: "herdr_btw_live_agent_race",
          outcome: "confirmed",
          paneId: "w1:p2",
        });
        expect(operationCount(test.calls, "inspect live agents")).toBe(2);
        expect(operationNames(test.calls)).not.toContain("start side-session Pi");
      }),
    );
  }

  it.effect("fails closed before any Herdr call on an invalid, reparented or aliased child", () =>
    Effect.gen(function* () {
      for (const options of [
        { probes: { [CHILD_FILE]: { _tag: "invalid" } } },
        { probes: { [CHILD_FILE]: { _tag: "valid", header: { id: "different-id" } } } },
        {
          probes: {
            [CHILD_FILE]: {
              _tag: "valid",
              header: { id: CHILD_ID, parentSession: "/sessions/other-parent.jsonl" },
            },
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

  it.effect("rejects a malformed parent ID before any client call", () =>
    Effect.gen(function* () {
      const invalidParent = fixture({ sessionId: "bad session id" });
      yield* Effect.flip(invalidParent.open());
      expect(invalidParent.calls).toEqual([]);
    }),
  );

  it.effect("fails closed before client calls when the recorded link is malformed", () =>
    Effect.gen(function* () {
      const test = fixture({ restoreOverride: { _tag: "malformed" } });
      expect(yield* Effect.flip(test.open())).toMatchObject({
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
        compareSessionFileIdentity: aliasIdentity([CHILD_FILE, CHILD_ALIAS]),
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
      yield* Effect.flip(withReadiness(test.openNew()));
      expect(test.recordedLinks).toEqual([LINK]);
      expect(test.linkStore.restore()).toEqual({ _tag: "restored", link: LINK });
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

  it.effect("focus follows prompt settlement even when prompt outcome is uncertain", () =>
    Effect.gen(function* () {
      const test = fixture({
        initialLinks: [LINK],
        liveAgents: [liveChildAgent()],
        failOperation: "prompt side-session Pi",
      });
      yield* Effect.flip(test.open("question"));
      expect(operationNames(test.calls).slice(-2)).toEqual([
        "prompt side-session Pi",
        "focus side-session Pi",
      ]);
    }),
  );

  for (const [recordResult, code, outcome, message] of [
    ["refused", "herdr_btw_link_record_refused", "confirmed", "was not recorded"],
    [
      "uncertain",
      "herdr_btw_link_record_outcome_uncertain",
      "uncertain",
      "Pane w1:p2 was retained",
    ],
  ] as const) {
    it.effect(`does not reread, retry or hand off after a ${recordResult} link record`, () =>
      Effect.gen(function* () {
        const test = fixture({ recordResult });
        const error = yield* Effect.flip(withReadiness(test.openNew("do not deliver")));
        expect(error).toMatchObject({ code, outcome, paneId: "w1:p2" });
        expect(error.message).toContain(message);
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
