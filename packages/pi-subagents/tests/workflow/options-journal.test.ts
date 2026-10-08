import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { makeWorkflowReplay, WORKFLOW_JOURNAL_MAX_CHARS } from "../../src/workflow/journal.ts";
import {
  WORKFLOW_AGENT_LABEL_MAX_CHARS,
  WORKFLOW_PHASE_TITLE_MAX_CHARS,
  WORKFLOW_RETAINED_RUNS,
} from "../../src/workflow/model.ts";
import { decodeWorkflowAgentOptions, workflowAgentJournalKey } from "../../src/workflow/options.ts";
import { withJournal, workflowSessionKey } from "./fixtures/workflow-harness.ts";

/** Where an inline script without a saved copy restarts from. */
const inlineOrigin = { source: { kind: "inline" } } as const;
const decode = (raw: Schema.Json) => Effect.runSync(Effect.result(decodeWorkflowAgentOptions(raw)));
const rejection = (raw: Schema.Json): string => {
  const result = decode(raw);
  if (result._tag === "Success") throw new Error("Expected the options to be rejected");
  return result.failure.message;
};

describe("agent() options", () => {
  it("accepts the supported options", () => {
    expect(
      decode({
        label: "reviewer",
        phase: "Review",
        schema: { type: "string" },
        profile: "worker",
        isolation: "worktree",
        writes: ["src/a.ts"],
      })._tag,
    ).toBe("Success");
    expect(decode({})._tag).toBe("Success");
  });

  it("explains route options and names unknown options", () => {
    expect(rejection({ model: "opus" })).toContain("Pi profiles choose");
    expect(rejection({ agentType: "general-purpose" })).toContain("profile");
    expect(rejection({ labl: "x" })).toContain("`labl`");
    expect(rejection("opts")).toContain("must be an object");
    expect(rejection({ isolation: "container" })).toContain("Invalid agent() options");
    expect(rejection({ writes: [] })).toContain("Invalid agent() options");
  });

  it("names the profile nearest a Claude Code agent type, or the available profiles", () => {
    const nearest = {
      Explore: "scout",
      Plan: "planner",
      "general-purpose": "generalist",
      "code-reviewer": "reviewer",
      "security-review": "reviewer",
    };
    for (const [agentType, profile] of Object.entries(nearest))
      expect(rejection({ agentType }), agentType).toContain(`profile: "${profile}"`);
    for (const [option, value] of [
      ["agentType", "statusline-setup"],
      ["model", "opus"],
      ["effort", "high"],
    ] as const) {
      const message = rejection({ [option]: value });
      expect(message).toContain(`\`${option}\``);
      for (const profile of ["scout", "planner", "worker", "reviewer", "generalist"])
        expect(message).toContain(profile);
    }
  });

  it("clips presentation options instead of rejecting the call", () => {
    const decoded = decode({ label: `verify: ${"claim ".repeat(40)}`, phase: "p".repeat(300) });
    if (decoded._tag === "Failure") throw new Error(decoded.failure.message);
    expect(decoded.success.label?.length).toBeLessThanOrEqual(WORKFLOW_AGENT_LABEL_MAX_CHARS);
    expect(decoded.success.label?.startsWith("verify: claim")).toBe(true);
    expect(decoded.success.phase?.length).toBeLessThanOrEqual(WORKFLOW_PHASE_TITLE_MAX_CHARS);
    const empty = decode({ label: "  ", phase: "" });
    if (empty._tag === "Failure") throw new Error(empty.failure.message);
    expect(empty.success).toEqual({});
  });

  it("treats null options as omitted but still names unknown ones", () => {
    const decoded = decode({ label: null, phase: null, profile: null, schema: null, writes: null });
    if (decoded._tag === "Failure") throw new Error(decoded.failure.message);
    expect(decoded.success).toEqual({});
    expect(rejection({ labl: null })).toContain("`labl`");
  });

  it("keys a call by the profile it runs with, however the script spells it", () => {
    const keyOf = (raw: Schema.Json) => {
      const decoded = decode(raw);
      if (decoded._tag === "Failure") throw new Error(decoded.failure.message);
      return workflowAgentJournalKey("p", decoded.success, undefined);
    };
    expect(keyOf({ profile: "generalist" })).toBe(keyOf({}));
    expect(keyOf({ profile: " reviewer " })).toBe(keyOf({ profile: "reviewer" }));
    expect(keyOf({ profile: "reviewer" })).not.toBe(keyOf({}));
  });

  it("keys resume entries on route-affecting options only", () => {
    const base = workflowAgentJournalKey("p", { label: "a", phase: "x" }, undefined);
    expect(workflowAgentJournalKey("p", { label: "b" }, undefined)).toBe(base);
    expect(workflowAgentJournalKey("p", { profile: "worker" }, undefined)).not.toBe(base);
    expect(workflowAgentJournalKey("p", {}, "digest")).not.toBe(base);
    expect(workflowAgentJournalKey("q", {}, undefined)).not.toBe(base);
    expect(workflowAgentJournalKey("p", { writes: ["b", "a"] }, undefined)).toBe(
      workflowAgentJournalKey("p", { writes: ["a", "b"] }, undefined),
    );
  });
});

describe("workflow journal", () => {
  const entry = (key: string, result: Schema.Json) => ({ key, result, outputTokens: 1, chars: 1 });

  it("replays results per key in call order", () => {
    const replay = makeWorkflowReplay([entry("a", 1), entry("b", 2), entry("a", 3)]);
    expect(replay.take("a")?.result).toBe(1);
    expect(replay.take("a")?.result).toBe(3);
    expect(replay.take("a")).toBeUndefined();
    expect(replay.take("b")?.result).toBe(2);
  });

  it.live("finds runs recorded by an earlier activation of the same session", () =>
    Effect.gen(function* () {
      const session = workflowSessionKey();
      yield* withJournal(session, (journal) =>
        Effect.andThen(
          journal.open("wf-1", "review", inlineOrigin),
          journal.record("wf-1", entry("k", "kept")),
        ),
      );
      const replay = yield* withJournal(session, (journal) => journal.replay("wf-1"));
      expect(replay?.take("k")?.result).toBe("kept");
      const other = yield* withJournal(`${session}-other`, (journal) => journal.replay("wf-1"));
      expect(other).toBeUndefined();
    }),
  );

  it.live("keeps a running run's journal however many later runs finish", () =>
    Effect.gen(function* () {
      const session = workflowSessionKey();
      yield* withJournal(session, (journal) =>
        Effect.gen(function* () {
          yield* journal.open("wf-long", "long", inlineOrigin);
          yield* journal.record("wf-long", entry("early", "kept"));
          for (let index = 0; index < WORKFLOW_RETAINED_RUNS + 8; index++) {
            yield* journal.open(`wf-short-${index}`, "short", inlineOrigin);
            yield* journal.finish(`wf-short-${index}`);
          }
        }),
      );
      const replay = yield* withJournal(session, (journal) => journal.replay("wf-long"));
      expect(replay?.take("early")?.result).toBe("kept");
      const oldest = yield* withJournal(session, (journal) => journal.replay("wf-short-0"));
      expect(oldest).toBeUndefined();
    }),
  );

  it.live("keeps the newest finished run resumable however large it is", () =>
    Effect.gen(function* () {
      const session = workflowSessionKey();
      const large = { ...entry("big", "kept"), chars: WORKFLOW_JOURNAL_MAX_CHARS + 1 };
      yield* withJournal(session, (journal) =>
        Effect.gen(function* () {
          yield* journal.open("wf-large", "large", inlineOrigin);
          yield* journal.record("wf-large", large);
          yield* journal.finish("wf-large");
        }),
      );
      // It just failed, so the main agent may resume it right away.
      const replay = yield* withJournal(session, (journal) => journal.replay("wf-large"));
      expect(replay?.take("big")?.result).toBe("kept");
      // Once a newer run finishes, the size bound applies to it again.
      yield* withJournal(session, (journal) =>
        Effect.andThen(journal.open("wf-next", "next", inlineOrigin), journal.finish("wf-next")),
      );
      expect(yield* withJournal(session, (journal) => journal.replay("wf-large"))).toBeUndefined();
      expect(yield* withJournal(session, (journal) => journal.replay("wf-next"))).toBeDefined();
    }),
  );

  it.live("reports runs an earlier activation left open until their notice is accepted", () =>
    Effect.gen(function* () {
      const session = workflowSessionKey();
      yield* withJournal(session, (journal) =>
        Effect.gen(function* () {
          yield* journal.open("wf-done", "done", inlineOrigin);
          yield* journal.finish("wf-done");
          yield* journal.open("wf-torn", "migration", inlineOrigin);
          yield* journal.record("wf-torn", { ...entry("a", "ok"), workspaceId: "workspace-1" });
          yield* journal.noteWorkspace("wf-torn", "workspace-2");
          // A worktree discarded because it held no changes leaves nothing to recover.
          yield* journal.noteWorkspace("wf-torn", "workspace-3");
          yield* journal.dropWorkspace("wf-torn", "workspace-3");
          yield* journal.open("wf-stopping", "cleanup", inlineOrigin);
          yield* journal.noteStop("wf-stopping");
        }),
      );
      const interrupted = yield* withJournal(session, (journal) => journal.interruptedRuns);
      expect(interrupted).toEqual([
        {
          runId: "wf-torn",
          name: "migration",
          finished: 1,
          workspaces: ["workspace-1", "workspace-2"],
          origin: inlineOrigin,
        },
        {
          runId: "wf-stopping",
          name: "cleanup",
          finished: 0,
          workspaces: [],
          stopped: true,
          origin: inlineOrigin,
        },
      ]);
      // A notice a teardown dropped is reported again by the next activation.
      expect(yield* withJournal(session, (journal) => journal.interruptedRuns)).toHaveLength(2);
      yield* withJournal(session, (journal) =>
        Effect.andThen(journal.finish("wf-torn"), journal.finish("wf-stopping")),
      );
      expect(yield* withJournal(session, (journal) => journal.interruptedRuns)).toEqual([]);
      // The interrupted run can still be resumed.
      const replay = yield* withJournal(session, (journal) => journal.replay("wf-torn"));
      expect(replay?.take("a")?.result).toBe("ok");
    }),
  );
});
