import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import {
  HerdrClient,
  type HerdrClientContract,
  type HerdrStartSideSessionInput,
} from "../src/boundary/herdr-client.ts";
import type { HerdrBtwLinkStore } from "../src/boundary/host-link-store.ts";
import type { HerdrBtwSessionInput } from "../src/boundary/host-session.ts";
import type { SessionFileIdentityComparator } from "../src/boundary/session-file.ts";
import type { HerdrBtwLink } from "../src/btw/link.ts";
import { makeAgentName, parentBtwDisplayName, selectSplitDirection } from "../src/btw/policy.ts";
import { makeHerdrBtwService } from "../src/btw/service.ts";
import {
  makeHerdrBtwCallRecorder,
  operationInputs,
  operationNames,
  withShellReadiness,
} from "./fixtures/herdr-btw-harness.ts";

const SESSION_FILE = "/sessions/parent.jsonl";
const SESSION_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const CHILD_ID = "0198aaaa-7564-4c88-8b67-child0btw001";
const CHILD_FILE = "/sessions/child.jsonl";
const CHILD_ALIAS = "/sessions/aliases/../child.jsonl";
const CWD = "/project";

interface FixtureOptions {
  readonly width?: number;
  readonly protocol?: number;
  readonly integrationCurrent?: boolean;
  readonly layoutWorkspaceId?: string;
  readonly splitTabId?: string;
  readonly startedSession?: string;
  readonly startedSessionKind?: "id" | "path";
  readonly startedIdentityAvailable?: boolean;
  readonly startedTerminalId?: string;
  readonly compareSessionFileIdentity?: SessionFileIdentityComparator;
  readonly shellReadyAfter?: number;
  readonly shellReadiness?: ReadonlyArray<boolean>;
  readonly failOperation?: string;
}

const fixture = (options: FixtureOptions = {}) => {
  const { calls, run } = makeHerdrBtwCallRecorder(options.failOperation);
  let shellInspections = 0;
  let startedAgentName: string | undefined;
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
    tab_id: options.splitTabId ?? "w1:t1",
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
        value: options.startedSession ?? CHILD_FILE,
      },
    };
  };

  const client = HerdrClient.of({
    inspectProtocol: () => run("inspect protocol", undefined, () => options.protocol ?? 19),
    inspectPiIntegration: () =>
      run("inspect Pi integration", undefined, () => options.integrationCurrent ?? true),
    resolveCallingPane: () => run("resolve calling pane", undefined, () => parentPane),
    inspectPaneLayout: (paneId) =>
      run("inspect calling pane layout", { paneId }, () => ({
        workspace_id: options.layoutWorkspaceId ?? "w1",
        tab_id: "w1:t1",
        area: { width: options.width ?? 160, height: 40 },
      })),
    splitPane: (input) => run("split BTW pane", input, () => btwPane),
    inspectPaneProcessInfo: (paneId) =>
      run("inspect BTW pane shell", { paneId }, () => {
        shellInspections += 1;
        const ready =
          options.shellReadiness?.[shellInspections - 1] ??
          shellInspections >= (options.shellReadyAfter ?? 1);
        return ready
          ? {
              pane_id: btwPane.pane_id,
              shell_pid: 4242,
              foreground_process_group_id: 4242,
              foreground_processes: [{ pid: 4242, name: "zsh" }],
            }
          : { pane_id: btwPane.pane_id };
      }),
    startSideSessionPi: (input) =>
      run("start side-session Pi", input, () => {
        startedAgentName = input.agentName;
        return startedAgentSnapshot(input.agentName);
      }),
    inspectLiveAgents: () =>
      run("inspect live agents", undefined, () =>
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
                  kind: "path" as const,
                  value: CHILD_FILE,
                },
              },
            ],
      ),
    promptSideSessionPi: (agentName, prompt) =>
      run("prompt side-session Pi", { agentName, prompt }, () => undefined),
    focusSideSessionPi: (agentName) => run("focus side-session Pi", { agentName }, () => undefined),
  } satisfies HerdrClientContract);

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
      recordedLinks.push({
        version: 1,
        parentSessionId: SESSION_ID,
        parentSessionPath: SESSION_FILE,
        ...link,
      });
      return "recorded";
    },
  };
  const serviceOptions = {
    probeSessionHeader: (path: string) => {
      if (path === SESSION_FILE) return { _tag: "valid", header: { id: SESSION_ID } } as const;
      return path === CHILD_FILE
        ? ({ _tag: "valid", header: { id: CHILD_ID } } as const)
        : ({ _tag: "invalid" } as const);
    },
    compareSessionFileIdentity:
      options.compareSessionFileIdentity ??
      ((leftPath: string, rightPath: string) =>
        leftPath === rightPath ? ("same" as const) : ("distinct" as const)),
    createChildSessionId: () => CHILD_ID,
    createBlankChildSessionFile: () =>
      Effect.succeed({ _tag: "created" as const, path: CHILD_FILE }),
  };
  const makeService = makeHerdrBtwService(input, linkStore, serviceOptions).pipe(
    Effect.provideService(HerdrClient, client),
  );
  const open = (prompt?: string | undefined) =>
    Effect.flatMap(makeService, (service) => service.open(prompt));

  return { calls, client, input, linkStore, makeService, open, recordedLinks, serviceOptions };
};

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
      expect(operationNames(test.calls).slice(0, 5)).toEqual([
        "inspect protocol",
        "inspect Pi integration",
        "resolve calling pane",
        "inspect calling pane layout",
        "split BTW pane",
      ]);
      expect(operationInputs(test.calls, "inspect BTW pane shell")).toHaveLength(6);
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
        compareSessionFileIdentity: (leftPath, rightPath) =>
          [leftPath, rightPath].every((path) => path === CHILD_FILE || path === CHILD_ALIAS)
            ? "same"
            : leftPath === rightPath
              ? "same"
              : "distinct",
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
        { ...test.input, environment: { HERDR_ENV: "1" } },
        test.linkStore,
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
        const service = yield* makeHerdrBtwService(test.input, test.linkStore, {
          ...test.serviceOptions,
          probeSessionHeader: (path) =>
            path === SESSION_FILE ? parentProbe : test.serviceOptions.probeSessionHeader(path),
        }).pipe(Effect.provideService(HerdrClient, test.client));
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
          compareSessionFileIdentity: (leftPath, rightPath) =>
            [leftPath, rightPath].every((path) => path === CHILD_FILE || path === SESSION_FILE)
              ? result
              : leftPath === rightPath
                ? "same"
                : "distinct",
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
