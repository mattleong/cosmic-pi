import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { SubagentServiceContract } from "../run/service.ts";
import type { WorkflowAgentAccess, WorkflowAgentCallError } from "./agent.ts";
import type { WorkflowJournalEntry, WorkflowReplay } from "./journal.ts";
import type { WorkflowAgentView } from "./model.ts";
import type { WorkflowAgentOptions } from "./options.ts";

/** A result reused from the resumed run, and the entry its view counts. */
export interface WorkflowReused {
  readonly entry: WorkflowJournalEntry;
  readonly counted: WorkflowJournalEntry;
}

/** A call that claims a planned agent the user skipped, which starts nothing. */
export interface WorkflowSkippedCall<A> {
  /**
   * Claims the skipped entry the call would claim and publishes the call's view, already skipped,
   * in one step; undefined, changing nothing, when the call would claim no skipped entry.
   */
  readonly claim: Effect.Effect<WorkflowAgentView | undefined>;
  /** Settles the call that claimed it, which resolves null at once. */
  readonly settle: (agent: WorkflowAgentView) => Effect.Effect<A>;
}

/**
 * Decides, once every call issued before it has, whether a call claims a planned agent the user
 * skipped, reuses a result of the resumed run, or runs live. A skipped call claims its entry in
 * its turn, so no later call can see that entry, and it neither takes a result nor closes the
 * replay, since it starts nothing; like a reused call, it isn't checked. A claimed skip or a
 * reused result is settled in the same uninterruptible step that decided it, so a stop can't drop
 * it from the new run's journal; a call that runs live gets undefined once `check` has accepted
 * it.
 */
export type WorkflowConsult = <A>(
  key: string,
  options: WorkflowAgentOptions,
  check: Effect.Effect<WorkflowAgentAccess, WorkflowAgentCallError>,
  settle: (reused: WorkflowReused) => Effect.Effect<A>,
  skipped: WorkflowSkippedCall<A>,
) => Effect.Effect<A | undefined, WorkflowAgentCallError>;

export interface WorkflowReuse {
  /**
   * Runs one agent() call, which takes its turn at the replay in its very first step, so turns
   * follow the order the script issued its calls. A call that ends before it consults the replay
   * still gives its turn up.
   */
  readonly inIssueOrder: <A, E>(
    call: (consult: WorkflowConsult) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}

export interface WorkflowReuseRun {
  readonly replay: WorkflowReplay | undefined;
  readonly log: (level: "info" | "warning", message: string) => Effect.Effect<void>;
}

/** Why a resumed worktree writer runs again instead of reusing its result. */
const rerunReason = (workspaceId: string, status: "closed" | "unbound"): string =>
  status === "closed"
    ? `its worktree ${workspaceId} was discarded, or its integration wasn't confirmed, so its edit may not be in the checkout.`
    : `its worktree ${workspaceId} was created before the session was reloaded, navigated or replaced, so this session can't review or integrate it.`;

const liveFromHereLine = (label: string | undefined): string =>
  `${label === undefined ? "A writer" : `Writer "${label}"`} runs live without isolation: "worktree", so every later agent() call runs live instead of reusing results that may predate its edits.`;

/**
 * A fresh run has no replay: a call that claims a planned agent the user skipped settles at once,
 * and every other call is checked and runs live.
 */
const freshConsult: WorkflowConsult = (_key, _options, check, _settle, skipped) =>
  Effect.uninterruptibleMask((restore) =>
    skipped.claim.pipe(
      Effect.flatMap((agent) =>
        agent === undefined ? restore(check).pipe(Effect.as(undefined)) : skipped.settle(agent),
      ),
    ),
  );

/**
 * How one run's agent() calls reuse results of the run it resumes. Results are content-addressed,
 * but a writer without worktree isolation that runs live may change what later calls would find,
 * so once one misses the replay, every call issued after it runs live. That holds whatever the
 * session writer mode, which can change between runs. Calls consult the replay one at a time in
 * issue order, and the writer's miss closes the replay in the same turn.
 */
export const makeWorkflowReuse = (
  run: WorkflowReuseRun,
  subagents: Pick<SubagentServiceContract, "workspaceBindingStatus">,
): WorkflowReuse => {
  const replay = run.replay;
  if (!replay) return { inIssueOrder: (call) => Effect.suspend(() => call(freshConsult)) };
  let previousTurn: Deferred.Deferred<void> | undefined;
  /** Set by the miss of a writer without worktree isolation; later calls skip the replay. */
  let closed = false;

  /**
   * A worktree writer's result is reused only while its edit awaits review, listed as a
   * proposal, or after it was integrated into the checkout, unlisted. A writer whose worktree
   * was discarded, whose integration is unconfirmed, or that this session never bound, runs
   * again: its entry misses like any other, so a writer without isolation: "worktree" closes the
   * replay, since the session's writer mode may now put its rerun in the checkout.
   */
  const bound = (entry: WorkflowJournalEntry, options: WorkflowAgentOptions) =>
    Effect.gen(function* () {
      if (entry.workspaceId === undefined) return { entry, counted: entry };
      const status = yield* subagents.workspaceBindingStatus(entry.workspaceId);
      if (status === "pending") return { entry, counted: entry };
      if (status === "integrated") {
        const { workspaceId: _integrated, ...counted } = entry;
        return { entry, counted };
      }
      const label = options.label ?? entry.label ?? "agent";
      yield* run.log(
        "info",
        `agent "${label}" runs again instead of reusing its earlier result: ${rerunReason(entry.workspaceId, status)}`,
      );
      return undefined;
    });

  const inIssueOrder: WorkflowReuse["inIssueOrder"] = (call) =>
    Effect.suspend(() => {
      const before = previousTurn;
      const turn = Deferred.makeUnsafe<void>();
      previousTurn = turn;
      const release = Deferred.succeed(turn, undefined);
      const consult: WorkflowConsult = (key, options, check, settle, skipped) =>
        // Only the wait for the turn and the checks can be interrupted: a claimed skip, or an
        // entry taken from the replay, is bound and settled before a stop takes effect.
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // One turn: a skipped call's claim, whether the call reuses, its miss and a writer's
            // closing of the replay are all decided before any later call looks.
            const decided = yield* Effect.gen(function* () {
              if (before) yield* restore(Deferred.await(before));
              const skippedAgent = yield* skipped.claim;
              if (skippedAgent) return { skipped: skippedAgent };
              const entry = closed ? undefined : replay.take(key);
              const hit = entry === undefined ? undefined : yield* bound(entry, options);
              if (hit) return { reused: hit };
              const access = yield* restore(check);
              if (!closed && access === "writer" && options.isolation !== "worktree") {
                closed = true;
                yield* run.log("info", liveFromHereLine(options.label));
              }
              return undefined;
            }).pipe(Effect.ensuring(release));
            if (decided === undefined) return undefined;
            return "skipped" in decided
              ? yield* skipped.settle(decided.skipped)
              : yield* settle(decided.reused);
          }),
        );
      return call(consult).pipe(Effect.ensuring(release));
    });

  return { inIssueOrder };
};
