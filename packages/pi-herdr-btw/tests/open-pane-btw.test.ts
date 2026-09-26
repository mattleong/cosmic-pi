import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { type HerdrStartSideSessionInput } from "../src/boundary/herdr-client.ts";
import { makeAgentName, parentBtwDisplayName, selectSplitDirection } from "../src/btw/policy.ts";
import {
  makeServiceFixture,
  operationCount,
  operationInputs,
  operationNames,
  withShellReadiness,
  type HerdrBtwFixtureOptions,
  aliasIdentity,
} from "./fixtures/herdr-btw-harness.ts";

const SESSION_FILE = "/sessions/parent.jsonl";
const SESSION_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const CHILD_ID = "0198aaaa-7564-4c88-8b67-child0btw001";
const CHILD_FILE = "/sessions/child.jsonl";
const CHILD_ALIAS = "/sessions/aliases/../child.jsonl";
const CWD = "/project";

const fixture = (options: HerdrBtwFixtureOptions = {}) =>
  makeServiceFixture({
    protocol: 19,
    createdChildId: CHILD_ID,
    createdChildFile: CHILD_FILE,
    ...options,
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

  it("derives the child display name without host path state", () => {
    expect(parentBtwDisplayName("/work/project/")).toBe("BTW · project");
    expect(parentBtwDisplayName("C:\\work\\project")).toBe("BTW · project");
    expect(parentBtwDisplayName("/")).toBe("BTW · Pi");
  });
});

describe("herdr-btw workflow", () => {
  it.effect("splits, starts, prompts, focuses, and transfers ownership in order", () =>
    Effect.gen(function* () {
      const test = fixture();
      const result = yield* withShellReadiness(test.open("--review the plan"));
      expect(result).toMatchObject({ paneId: "w1:p2", mode: "created" });
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
      expect(operationNames(test.calls).slice(-3)).toEqual([
        "start side-session Pi",
        "prompt side-session Pi",
        "focus side-session Pi",
      ]);
      expect(operationInputs(test.calls, "split BTW pane")[0]).toEqual({
        parentPaneId: "w1:p1",
        direction: "right",
        cwd: CWD,
      });
      expect(
        operationInputs<HerdrStartSideSessionInput>(test.calls, "start side-session Pi")[0],
      ).toEqual({
        agentName: result.agentName,
        paneId: "w1:p2",
        childSessionId: CHILD_ID,
        childSessionPath: CHILD_FILE,
        parentSessionId: SESSION_ID,
        parentSessionPath: SESSION_FILE,
        displayName: "BTW · project",
      });
      expect(operationInputs(test.calls, "prompt side-session Pi")[0]).toEqual({
        agentName: result.agentName,
        prompt: "Side-session request:\n--review the plan",
      });
      expect(operationInputs(test.calls, "focus side-session Pi")[0]).toEqual({
        agentName: result.agentName,
      });
    }),
  );

  it.effect("uses a down split and omits prompt delivery when no prompt is supplied", () =>
    Effect.gen(function* () {
      const test = fixture({ width: 80 });
      yield* withShellReadiness(test.open());
      expect(operationInputs(test.calls, "split BTW pane")[0]).toMatchObject({ direction: "down" });
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
    }),
  );

  it.effect("waits through read-only shell inspections without retrying mutations", () =>
    Effect.gen(function* () {
      const test = fixture({ shellReadyAfter: 3 });
      yield* withShellReadiness(test.open());
      expect(operationInputs(test.calls, "inspect BTW pane shell")).toHaveLength(8);
      for (const operation of ["split BTW pane", "start side-session Pi", "focus side-session Pi"])
        expect(operationCount(test.calls, operation)).toBe(1);
    }),
  );

  for (const [name, options, code = "herdr_agent_ownership_mismatch"] of [
    ["startup omits exact Pi session identity", { startedIdentityAvailable: false }],
    ["startup reports another terminal", { startedTerminalId: "term-other" }],
    ["startup reports the parent session", { startedSession: SESSION_FILE }],
    ["startup reports ID-only session evidence", { startedSessionKind: "id" }],
    [
      "startup has an uncertain failure",
      { failOperation: "start side-session Pi" },
      "fixture_start_side-session_pi",
    ],
  ] satisfies Array<[string, HerdrBtwFixtureOptions, string?]>) {
    it.effect(`retains the pane without prompting or adopting when ${name}`, () =>
      Effect.gen(function* () {
        const test = fixture(options);
        const error = yield* Effect.flip(withShellReadiness(test.open("Do not misroute this.")));
        expect(error).toMatchObject({ code, outcome: "uncertain", paneId: "w1:p2" });
        expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
        expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
        expect(test.recordedLinks).toEqual([]);
        expect(operationCount(test.calls, "start side-session Pi")).toBe(1);
      }),
    );
  }

  it.effect("accepts path startup evidence for the same filesystem identity", () =>
    Effect.gen(function* () {
      const test = fixture({
        startedSession: CHILD_ALIAS,
        compareSessionFileIdentity: aliasIdentity([CHILD_FILE, CHILD_ALIAS]),
      });

      expect(yield* withShellReadiness(test.open())).toMatchObject({ mode: "created" });
      expect(test.recordedLinks[0]?.childSessionPath).toBe(CHILD_FILE);
    }),
  );

  it.effect("resets stability after a transient shell-owned sample", () =>
    Effect.gen(function* () {
      const test = fixture({
        shellReadiness: [true, true, false, true, true, true, true, true, true],
      });
      yield* withShellReadiness(test.open());
      expect(operationInputs(test.calls, "inspect BTW pane shell")).toHaveLength(9);
      expect(operationCount(test.calls, "start side-session Pi")).toBe(1);
    }),
  );

  it.effect("retains the pane when a shell inspection fails", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "inspect BTW pane shell" });
      expect(yield* Effect.flip(test.open())).toMatchObject({
        code: "fixture_inspect_btw_pane_shell",
        outcome: "confirmed",
        paneId: "w1:p2",
      });
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect("retains the pane and skips launch after the shell-readiness deadline", () =>
    Effect.gen(function* () {
      const test = fixture({ shellReadyAfter: 100 });
      expect(yield* Effect.flip(withShellReadiness(test.open()))).toMatchObject({
        code: "herdr_btw_pane_shell_not_ready",
        outcome: "confirmed",
        paneId: "w1:p2",
      });
      expect(operationInputs(test.calls, "inspect BTW pane shell")).toHaveLength(31);
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect("requires inherited Herdr caller identity before any client call", () =>
    Effect.gen(function* () {
      const test = fixture({ environment: { HERDR_ENV: "1" } });
      expect((yield* Effect.flip(test.open())).code).toBe("herdr_environment_unavailable");
      expect(test.calls).toEqual([]);
    }),
  );

  it.effect("requires an exact bounded parent session header before a client call", () =>
    Effect.gen(function* () {
      for (const parentProbe of [
        { _tag: "invalid" as const },
        { _tag: "valid" as const, header: { id: "another-parent" } },
      ]) {
        const test = fixture({ probes: { [SESSION_FILE]: parentProbe } });
        expect(yield* Effect.flip(test.open())).toMatchObject({
          code:
            parentProbe._tag === "invalid"
              ? "parent_session_unavailable"
              : "parent_session_owner_mismatch",
          outcome: "confirmed",
        });
        expect(test.calls).toEqual([]);
      }
    }),
  );

  it.effect("rejects unsupported Herdr protocols before mutation", () =>
    Effect.gen(function* () {
      const test = fixture({ protocol: 16 });
      expect((yield* Effect.flip(test.open())).code).toBe("herdr_upgrade_required");
      expect(operationNames(test.calls)).toEqual(["inspect protocol"]);
    }),
  );

  it.effect("requires a current Pi integration before creating topology", () =>
    Effect.gen(function* () {
      const test = fixture({ integrationCurrent: false });
      expect(yield* Effect.flip(test.open())).toMatchObject({
        code: "herdr_pi_integration_unavailable",
        outcome: "confirmed",
      });
      expect(operationNames(test.calls)).toEqual(["inspect protocol", "inspect Pi integration"]);
    }),
  );

  it.effect("rejects a layout that no longer belongs to the calling pane", () =>
    Effect.gen(function* () {
      const test = fixture({ layoutWorkspaceId: "w2" });
      const error = yield* Effect.flip(test.open());
      expect(error.code).toBe("herdr_parent_topology_mismatch");
      expect(error.paneId).toBeUndefined();
      expect(operationNames(test.calls)).not.toContain("split BTW pane");
    }),
  );

  it.effect("refuses to launch when the split escapes the calling tab", () =>
    Effect.gen(function* () {
      const test = fixture({ splitTabId: "w1:t2" });
      expect(yield* Effect.flip(test.open())).toMatchObject({
        code: "herdr_split_topology_mismatch",
        outcome: "uncertain",
        paneId: "w1:p2",
      });
      expect(operationNames(test.calls)).not.toContain("start side-session Pi");
    }),
  );

  it.effect("focuses a confirmed session even when optional prompt delivery fails", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "prompt side-session Pi" });
      expect(
        yield* Effect.flip(withShellReadiness(test.open("Prompt that may not arrive."))),
      ).toMatchObject({
        code: "fixture_prompt_side-session_pi",
        outcome: "uncertain",
        paneId: "w1:p2",
      });
      expect(operationNames(test.calls).slice(-2)).toEqual([
        "prompt side-session Pi",
        "focus side-session Pi",
      ]);
    }),
  );

  it.effect("refuses parent-child aliases or unavailable identity before Pi startup", () =>
    Effect.gen(function* () {
      for (const result of ["same", "unavailable"] as const) {
        const test = fixture({
          compareSessionFileIdentity: aliasIdentity([CHILD_FILE, SESSION_FILE], result),
        });
        expect(yield* Effect.flip(withShellReadiness(test.open()))).toMatchObject({
          code: "herdr_btw_child_identity_invalid",
          outcome: "confirmed",
          paneId: "w1:p2",
        });
        expect(operationNames(test.calls)).not.toContain("start side-session Pi");
      }
    }),
  );
});
