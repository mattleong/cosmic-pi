import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { SubagentServiceContract } from "../run/service.ts";
import { requireWorkflowArgs } from "./args.ts";
import { workflowRequestError, type WorkflowRequestError } from "./errors.ts";
import type { WorkflowJournalContract, WorkflowReplay } from "./journal.ts";
import {
  isWorkflowRunFinished,
  WORKFLOW_RUN_PLANNED_LIMIT,
  type WorkflowPlannedAgent,
  type WorkflowSource,
} from "./model.ts";
import type { WorkflowRecovery } from "./recovery.ts";
import type { WorkflowRuns } from "./runs.ts";
import {
  parseWorkflowScript,
  type WorkflowPlannedAgentSpec,
  type WorkflowScript,
  type WorkflowScriptError,
} from "./script.ts";
import { nestedWorkflowPlanned, withNestedPhases } from "./state.ts";
import { WorkflowSourceError, type WorkflowStoreContract } from "./store.ts";

export type WorkflowSourceRequest =
  | { readonly kind: "inline"; readonly script: string }
  | { readonly kind: "saved"; readonly name: string }
  | { readonly kind: "file"; readonly path: string };

interface WorkflowSourcesServices {
  readonly store: Pick<WorkflowStoreContract, "load" | "loadPath">;
  readonly journal: Pick<WorkflowJournalContract, "replay">;
  readonly recovery: Pick<WorkflowRecovery, "replay">;
  readonly subagents: Pick<SubagentServiceContract, "reserveRunId">;
  readonly runs: Pick<WorkflowRuns, "find" | "modifyEffect">;
}

const NestedCallSchema = Schema.Tuple([
  Schema.Union([Schema.String, Schema.Struct({ scriptPath: Schema.String })]),
  Schema.Json,
]);
const decodeNestedCall = Schema.decodeUnknownOption(NestedCallSchema);

/** Script sources, resume lookup and planned-agent reservations for the session's runs. */
export const makeWorkflowSources = (services: WorkflowSourcesServices) => {
  const { store, journal, recovery, subagents, runs } = services;

  /** Parses an inline script, or loads a saved workflow or a script file, and says which. */
  const load = (
    source: WorkflowSourceRequest,
  ): Effect.Effect<
    { readonly script: WorkflowScript; readonly source: WorkflowSource },
    WorkflowScriptError | WorkflowSourceError
  > => {
    switch (source.kind) {
      case "inline":
        return parseWorkflowScript(source.script).pipe(
          Effect.map((script) => ({ script, source: { kind: "inline" } as const })),
        );
      case "saved":
        return store.load(source.name).pipe(
          Effect.map((loaded) => ({
            script: loaded.script,
            source: {
              kind: "saved" as const,
              name: loaded.name,
              scope: loaded.scope ?? "user",
              path: loaded.path,
            },
          })),
        );
      case "file":
        return store.loadPath(source.path).pipe(
          Effect.map((loaded) => ({
            script: loaded.script,
            source: { kind: "file" as const, path: loaded.path },
          })),
        );
    }
  };

  /**
   * The results a run resuming `runId` replays: from memory, or else from the run's files when
   * they name this session. It fails with `resume_running` while that run still runs here,
   * `resume_running_elsewhere` while it runs in another Pi process, `resume_other_session` for
   * another session's run, `resume_unrecorded` when its files hold no record,
   * `resume_unreadable` when its record or results journal can't be read, and `resume_unknown`
   * when neither memory nor files hold it.
   */
  const resumeReplay = (runId: string): Effect.Effect<WorkflowReplay, WorkflowRequestError> =>
    Effect.gen(function* () {
      const earlier = yield* runs.find(runId);
      if (earlier && !isWorkflowRunFinished(earlier.state))
        return yield* workflowRequestError(
          "resume_running",
          `Workflow ${runId} is still running. Stop it or wait for its result before resuming it.`,
        );
      // Memory holds the session's recent runs until Pi exits; run files cover the rest.
      return (yield* journal.replay(runId)) ?? (yield* recovery.replay(runId));
    });

  /** Planned agents with the subagent run ids their claiming calls will start under. */
  const reservePlanned = (specs: ReadonlyArray<WorkflowPlannedAgentSpec>) =>
    Effect.forEach(
      specs.slice(0, WORKFLOW_RUN_PLANNED_LIMIT),
      (spec): Effect.Effect<WorkflowPlannedAgent> =>
        subagents.reserveRunId.pipe(Effect.map((runId) => ({ runId, ...spec }))),
    );

  /**
   * Loads a script's `workflow(reference, args)` call, `[reference, args]` with args null when
   * omitted, where the reference is a saved workflow name or `{ scriptPath }`. It adds the nested
   * workflow's phases and planned agents to run `id` and returns its name and body for the
   * sandbox. It fails, adding nothing, when the reference doesn't load (`WorkflowSourceError`) or
   * args don't match its `meta.args` (`args_mismatch`); the script sees either as an invalid call.
   */
  const loadNested = (
    id: string,
    call: Schema.Json,
  ): Effect.Effect<Schema.Json, WorkflowSourceError | WorkflowRequestError> =>
    Effect.gen(function* () {
      const decoded = decodeNestedCall(call);
      if (Option.isNone(decoded))
        return yield* new WorkflowSourceError({
          message: "workflow() expects a saved workflow name or { scriptPath }.",
          problem: "bad-reference",
          subject: "workflow()",
        });
      const [reference, args] = decoded.value;
      const loaded = yield* Predicate.isString(reference)
        ? store.load(reference)
        : store.loadPath(reference.scriptPath);
      yield* requireWorkflowArgs(loaded.script.args, loaded.name, args);
      yield* runs.modifyEffect(id, (run) =>
        reservePlanned(nestedWorkflowPlanned(run, loaded.script, loaded.name)).pipe(
          Effect.map(
            (planned) =>
              [undefined, withNestedPhases(run, loaded.script, loaded.name, planned)] as const,
          ),
        ),
      );
      return { name: loaded.name, body: loaded.script.body };
    });

  return { load, resumeReplay, reservePlanned, loadNested };
};

export type WorkflowSources = ReturnType<typeof makeWorkflowSources>;
