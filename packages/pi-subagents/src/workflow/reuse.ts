import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { SubagentServiceContract } from "../run/service.ts";
import type { WorkflowAgentAccess } from "./agent.ts";
import type { WorkflowAgentCallError } from "./errors.ts";
import type { WorkflowJournalEntry, WorkflowReplay } from "./journal.ts";
import type { WorkflowAgentView } from "./model.ts";
import type { WorkflowAgentOptions } from "./options.ts";

interface WorkflowSkippedCall<A> {
  readonly claim: Effect.Effect<WorkflowAgentView | undefined>;
  readonly settle: (agent: WorkflowAgentView) => Effect.Effect<A>;
}

type WorkflowConsult = <A>(
  key: string,
  options: WorkflowAgentOptions,
  check: Effect.Effect<WorkflowAgentAccess, WorkflowAgentCallError>,
  settle: (reused: WorkflowJournalEntry) => Effect.Effect<A>,
  skipped: WorkflowSkippedCall<A>,
) => Effect.Effect<A | undefined, WorkflowAgentCallError>;

interface WorkflowReuse {
  readonly inIssueOrder: <A, E>(
    call: (consult: WorkflowConsult) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}

const rerunReason = (workspaceId: string, status: "closed" | "unbound"): string =>
  status === "closed"
    ? `its worktree ${workspaceId} was discarded, or its integration wasn't confirmed, so its edit may not be in the checkout.`
    : `its worktree ${workspaceId} was created before the session was reloaded, navigated or replaced, so this session can't review or integrate it.`;

const liveFromHereLine = (label: string | undefined): string =>
  `${label === undefined ? "A writer" : `Writer "${label}"`} runs live without isolation: "worktree", so every later agent() call runs live instead of reusing results that may predate its edits.`;

const freshConsult: WorkflowConsult = (_key, _options, check, _settle, skipped) =>
  Effect.uninterruptibleMask((restore) =>
    skipped.claim.pipe(
      Effect.flatMap((agent) =>
        agent === undefined ? restore(check).pipe(Effect.as(undefined)) : skipped.settle(agent),
      ),
    ),
  );

export const makeWorkflowReuse = (
  run: {
    readonly replay: WorkflowReplay | undefined;
    readonly log: (level: "info" | "warning", message: string) => Effect.Effect<void>;
  },
  subagents: Pick<SubagentServiceContract, "workspaceBindingStatus">,
): WorkflowReuse => {
  const replay = run.replay;
  if (!replay) return { inIssueOrder: (call) => Effect.suspend(() => call(freshConsult)) };
  let previousTurn: Deferred.Deferred<void> | undefined;
  let closed = false;

  const bound = (entry: WorkflowJournalEntry, options: WorkflowAgentOptions) =>
    Effect.gen(function* () {
      if (entry.workspaceId === undefined) return entry;
      const status = yield* subagents.workspaceBindingStatus(entry.workspaceId);
      if (status === "pending") return entry;
      if (status === "integrated") {
        const { workspaceId: _integrated, ...integrated } = entry;
        return integrated;
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
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
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
