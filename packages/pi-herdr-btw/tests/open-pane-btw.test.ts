import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { SessionHeaderProbe } from "../src/boundary/session-file.ts";
import {
  CHILD_FILE,
  CHILD_ID,
  CWD,
  makeServiceFixture as fixture,
  operationCount,
  operationInputs,
  operationNames,
  SESSION_FILE,
  SESSION_ID,
  withShellReadiness,
  type HerdrBtwFixtureOptions,
  aliasIdentity,
} from "./fixtures/herdr-btw-harness.ts";

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
      expect(operationInputs(test.calls, "start side-session Pi")[0]).toMatchObject({
        agentName: result.agentName,
        paneId: "w1:p2",
        childSessionId: CHILD_ID,
        childSessionPath: CHILD_FILE,
        parentSessionId: SESSION_ID,
        parentSessionPath: SESSION_FILE,
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

  for (const [name, options, code = "herdr_agent_ownership_mismatch"] of [
    ["startup reports the parent session", { startedSession: SESSION_FILE }],
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

  it.effect("reports an outdated Herdr before other preflight failures and before splitting", () =>
    Effect.gen(function* () {
      for (const options of [
        { protocol: 16 },
        { protocol: 16, failOperation: "inspect Pi integration" },
        { protocol: 16, failOperation: "resolve calling pane" },
      ] satisfies HerdrBtwFixtureOptions[]) {
        const test = fixture(options);
        expect(yield* Effect.flip(test.open())).toMatchObject({
          code: "herdr_upgrade_required",
          outcome: "confirmed",
        });
        expect(operationNames(test.calls)).not.toContain("split BTW pane");
      }
    }),
  );

  it.effect("requires an exact bounded parent session header before a client call", () =>
    Effect.gen(function* () {
      for (const [parentProbe, code] of [
        [SessionHeaderProbe.invalid(), "parent_session_unavailable"],
        [
          SessionHeaderProbe.valid({ header: { id: "another-parent" } }),
          "parent_session_owner_mismatch",
        ],
      ] as const) {
        const test = fixture({ probes: { [SESSION_FILE]: parentProbe } });
        expect(yield* Effect.flip(test.open())).toMatchObject({ code, outcome: "confirmed" });
        expect(test.calls).toEqual([]);
      }
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
