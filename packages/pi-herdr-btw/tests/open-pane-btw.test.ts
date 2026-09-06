import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { HerdrClient, type HerdrStartSideSessionInput } from "../src/boundary/herdr-client.ts";
import { makeAgentName, parentBtwDisplayName, selectSplitDirection } from "../src/btw/policy.ts";
import { makeHerdrBtwService } from "../src/btw/service.ts";
import {
  makeServiceFixture,
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
      const result = yield* withShellReadiness(test.open());
      expect(result.direction).toBe("down");
      expect(result.prompted).toBe(false);
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
    }),
  );

  it.effect("waits through read-only shell inspections without retrying mutations", () =>
    Effect.gen(function* () {
      const test = fixture({ shellReadyAfter: 3 });
      yield* withShellReadiness(test.open());
      expect(operationInputs(test.calls, "inspect BTW pane shell")).toHaveLength(8);
      for (const operation of ["split BTW pane", "start side-session Pi", "focus side-session Pi"])
        expect(operationNames(test.calls).filter((name) => name === operation)).toHaveLength(1);
    }),
  );

  it.effect("retains the pane when startup omits exact Pi session identity", () =>
    Effect.gen(function* () {
      const test = fixture({ startedIdentityAvailable: false });
      const result = yield* Effect.result(withShellReadiness(test.open("Review the BTW session.")));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "herdr_agent_ownership_mismatch",
          outcome: "uncertain",
          paneId: "w1:p2",
        });
      expect(operationNames(test.calls)).not.toContain("prompt side-session Pi");
      expect(operationNames(test.calls)).not.toContain("focus side-session Pi");
      expect(test.recordedLinks).toEqual([]);
      expect(
        operationNames(test.calls).filter((name) => name === "start side-session Pi"),
      ).toHaveLength(1);
    }),
  );

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

  it.effect("does not prompt or adopt mismatched startup evidence", () =>
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
      expect(
        operationNames(test.calls).filter((name) => name === "start side-session Pi"),
      ).toHaveLength(1);
      expect(test.recordedLinks).toEqual([]);
    }),
  );

  it.effect("resets stability after a transient shell-owned sample", () =>
    Effect.gen(function* () {
      const test = fixture({
        shellReadiness: [true, true, false, true, true, true, true, true, true],
      });
      yield* withShellReadiness(test.open());
      expect(operationInputs(test.calls, "inspect BTW pane shell")).toHaveLength(9);
      expect(
        operationNames(test.calls).filter((name) => name === "start side-session Pi"),
      ).toHaveLength(1);
    }),
  );

  it.effect("retains the pane when a shell inspection fails", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "inspect BTW pane shell" });
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
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
      const result = yield* Effect.result(withShellReadiness(test.open()));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
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
      const test = fixture();
      const service = yield* makeHerdrBtwService(
        { ...test.input, environment: { HERDR_ENV: "1" }, linkStore: test.linkStore },
        test.serviceOptions,
      ).pipe(Effect.provideService(HerdrClient, test.client));
      const result = yield* Effect.result(service.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.code).toBe("herdr_environment_unavailable");
      expect(test.calls).toEqual([]);
    }),
  );

  it.effect("requires an exact bounded parent session header before a client call", () =>
    Effect.gen(function* () {
      for (const parentProbe of [
        { _tag: "invalid" as const },
        { _tag: "valid" as const, header: { id: "another-parent" } },
      ]) {
        const test = fixture();
        const service = yield* makeHerdrBtwService(
          { ...test.input, linkStore: test.linkStore },
          {
            ...test.serviceOptions,
            probeSessionHeader: (path) =>
              path === SESSION_FILE ? parentProbe : test.serviceOptions.probeSessionHeader(path),
          },
        ).pipe(Effect.provideService(HerdrClient, test.client));
        const result = yield* Effect.result(service.open());
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
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
      const result = yield* Effect.result(test.open());
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("herdr_upgrade_required");
      expect(operationNames(test.calls)).toEqual(["inspect protocol"]);
    }),
  );

  it.effect("requires a current Pi integration before creating topology", () =>
    Effect.gen(function* () {
      const test = fixture({ integrationCurrent: false });
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

  it.effect("retains the pane when startup has an uncertain failure", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "start side-session Pi" });
      const result = yield* Effect.result(withShellReadiness(test.open()));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "fixture_start_side-session_pi",
          outcome: "uncertain",
          paneId: "w1:p2",
        });
      expect(
        operationNames(test.calls).filter((name) => name === "start side-session Pi"),
      ).toHaveLength(1);
      expect(test.recordedLinks).toEqual([]);
    }),
  );

  it.effect("focuses a confirmed session even when optional prompt delivery fails", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "prompt side-session Pi" });
      const result = yield* Effect.result(
        withShellReadiness(test.open("Prompt that may not arrive.")),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
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

  it.effect("reports focus failure without cleaning up a confirmed pane", () =>
    Effect.gen(function* () {
      const test = fixture({ failOperation: "focus side-session Pi" });
      const result = yield* Effect.result(withShellReadiness(test.open()));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          code: "fixture_focus_side-session_pi",
          outcome: "uncertain",
          paneId: "w1:p2",
        });
      expect(test.recordedLinks).toHaveLength(1);
    }),
  );

  it.effect("refuses parent-child aliases or unavailable identity before Pi startup", () =>
    Effect.gen(function* () {
      for (const result of ["same", "unavailable"] as const) {
        const test = fixture({
          compareSessionFileIdentity: aliasIdentity([CHILD_FILE, SESSION_FILE], result),
        });
        const outcome = yield* Effect.result(withShellReadiness(test.open()));

        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure")
          expect(outcome.failure).toMatchObject({
            code: "herdr_btw_child_identity_invalid",
            outcome: "confirmed",
            paneId: "w1:p2",
          });
        expect(operationNames(test.calls)).not.toContain("start side-session Pi");
      }
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
