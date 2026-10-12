import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type { WorkflowSandboxHost } from "../boundary/codemode-sandbox.ts";
import type { WorkflowRunFileError, WorkflowRunFiles } from "../boundary/workflow-run-files.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import { makeWorkflowAgentCall, type WorkflowHost } from "./agent.ts";
import type { WorkflowSlots } from "./admission-queue.ts";
import type { WorkflowBudget } from "./budget.ts";
import type { WorkflowJournalContract, WorkflowReplay } from "./journal.ts";
import { addWorkflowUsage, WORKFLOW_AGENT_LIMIT, type WorkflowAgentView } from "./model.ts";
import {
  workflowResultJsonLine,
  workflowResultOverflow,
  type WorkflowResultLine,
} from "./results.ts";
import type { WorkflowRunControl, WorkflowRuns } from "./runs.ts";
import type { WorkflowScript } from "./script.ts";
import type { WorkflowSources } from "./source.ts";
import {
  claimSkippedWorkflowPlanned,
  claimWorkflowPlanned,
  decodeWorkflowEvent,
  reuseWorkflowResult,
  withAgent,
  withAgentChange,
  workflowAgentFromDraft,
  workflowServiceLog,
  type WorkflowAgentDraft,
} from "./state.ts";
import type { WorkflowStoreContract } from "./store.ts";

export interface WorkflowRunSetup {
  readonly id: string;
  readonly script: WorkflowScript;
  readonly args: Schema.Json;
  readonly host: WorkflowHost;
  readonly replay: WorkflowReplay | undefined;
  readonly slots: WorkflowSlots;
  readonly budget: WorkflowBudget;
  readonly control: WorkflowRunControl;
  readonly files: WorkflowRunFiles | undefined;
}

interface WorkflowMembersServices {
  readonly runs: WorkflowRuns;
  readonly subagents: SubagentServiceContract;
  readonly journal: WorkflowJournalContract;
  readonly store: Pick<WorkflowStoreContract, "appendRunJournal" | "writeRunResult">;
  readonly sources: Pick<WorkflowSources, "loadNested">;
}

export const makeWorkflowMembers = (services: WorkflowMembersServices) => {
  const { runs, subagents, journal, store, sources } = services;

  const queueAgent = (
    setup: WorkflowRunSetup,
    draft: WorkflowAgentDraft,
    skip: Deferred.Deferred<void>,
  ) =>
    runs
      .modifyEffect(setup.id, (run) => {
        const [claimed, rest] = claimWorkflowPlanned(run, draft);
        return (claimed ? Effect.succeed(claimed.runId) : subagents.reserveRunId).pipe(
          Effect.flatMap((runId) =>
            Effect.sync(() => {
              const agent = workflowAgentFromDraft(draft, runId, claimed);
              if (agent.state === "queued") setup.control.skips.set(runId, skip);
              return [agent, withAgent(rest, agent)] as const;
            }),
          ),
        );
      })
      .pipe(
        Effect.filterOrElse(
          (agent): agent is WorkflowAgentView => agent !== undefined,
          () => Effect.die(new Error(`Workflow run ${setup.id} was evicted while it was live.`)),
        ),
      );

  const claimSkipped = (
    setup: WorkflowRunSetup,
    claim: Omit<WorkflowAgentDraft, "callId" | "queuedAt">,
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((queuedAt) =>
        runs.modify(setup.id, (run) => {
          const [claimed, rest] = claimSkippedWorkflowPlanned(run, claim);
          if (claimed === undefined) return [undefined, run] as const;
          const draft = { ...claim, callId: ++setup.control.calls, queuedAt };
          const agent = workflowAgentFromDraft(draft, claimed.runId, claimed);
          return [agent, withAgent(rest, agent)] as const;
        }),
      ),
    );

  const warnOnce = (setup: WorkflowRunSetup, error: WorkflowRunFileError) =>
    Effect.suspend(() => {
      const runJournal = setup.control.journal;
      if (runJournal.warned) return Effect.void;
      runJournal.warned = true;
      return runs.recordEvent(
        setup.id,
        workflowServiceLog("warning", `The results journal may be incomplete: ${error.message}`),
      );
    });

  const withFullResult = (
    setup: WorkflowRunSetup,
    files: WorkflowRunFiles,
    line: WorkflowResultLine,
  ) =>
    Effect.suspend(() => {
      const full = workflowResultOverflow(line.result);
      if (full === undefined) return Effect.succeed(line);
      const ordinal = ++setup.control.journal.results;
      return store.writeRunResult(files, ordinal, full).pipe(
        Effect.map((resultFile): WorkflowResultLine => ({ ...line, resultFile })),
        Effect.catch((error) =>
          warnOnce(setup, error).pipe(
            Effect.as<WorkflowResultLine>({ ...line, replayable: false }),
          ),
        ),
      );
    });

  const writeResult = (setup: WorkflowRunSetup, line: WorkflowResultLine): Effect.Effect<void> => {
    const files = setup.files;
    if (!files) return Effect.void;
    const written = setup.control.journal;
    return withFullResult(setup, files, line).pipe(
      Effect.flatMap((complete) => store.appendRunJournal(files, workflowResultJsonLine(complete))),
      setup.control.journalLock.withPermits(1),
      Effect.matchEffect({
        onSuccess: () => {
          if (written.written) return Effect.void;
          written.written = true;
          return runs.update(setup.id, (run) => ({ ...run, journalPath: files.journal }));
        },
        onFailure: (error) => warnOnce(setup, error),
      }),
      Effect.asVoid,
    );
  };

  return (setup: WorkflowRunSetup): WorkflowSandboxHost<never> => ({
    agent: makeWorkflowAgentCall(
      {
        workflowId: setup.id,
        workflowName: setup.script.meta.name,
        host: setup.host,
        replay: setup.replay,
        slots: setup.slots,
        budget: setup.budget,
        nextCall: Effect.sync(() =>
          setup.control.calls >= WORKFLOW_AGENT_LIMIT ? undefined : ++setup.control.calls,
        ),
        failRun: (message) =>
          Deferred.succeed(setup.control.failed, { message }).pipe(Effect.asVoid),
        queue: (draft, skip) => queueAgent(setup, draft, skip),
        claimSkipped: (claim) => claimSkipped(setup, claim),
        update: (runId, change) =>
          runs.update(setup.id, (run) => withAgentChange(run, runId, change)).pipe(Effect.asVoid),
        forget: (runId) => Effect.sync(() => void setup.control.skips.delete(runId)),
        log: (level, message) => runs.recordEvent(setup.id, workflowServiceLog(level, message)),
        stopRequested: setup.control.stop,
        count: (spend) =>
          runs
            .update(setup.id, (run) => ({ ...run, usage: addWorkflowUsage(run.usage, spend) }))
            .pipe(Effect.asVoid),
        reuse: (entry, claim) =>
          runs.modify(setup.id, (run) => reuseWorkflowResult(run, entry, claim)),
        writeResult: (line) => writeResult(setup, line),
      },
      { subagents, journal },
    ),
    event: (event) =>
      Option.match(decodeWorkflowEvent(event), {
        onNone: () => Effect.void,
        onSome: (decoded) => runs.recordEvent(setup.id, decoded),
      }),
    load: (call) => sources.loadNested(setup.id, call),
  });
};
