import * as Effect from "effect/Effect";
import type { CanonicalWriterCwd } from "../boundary/writer-lease.ts";
import {
  MAX_WRITE_CLAIMS,
  normalizeWriteClaims,
  writeClaimContains,
} from "../domain/write-claims.ts";
import { writerConflictError } from "./admission.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import { isTerminalRunState, type SubagentRunView } from "./model.ts";
import { snapshotView } from "./state.ts";

const isBlockingClaimQuestionTool = (toolName: string): boolean => {
  const normalized = toolName.trim().toLocaleLowerCase("en-US");
  return (
    normalized === "contact_parent" ||
    normalized === "supervisor_question" ||
    normalized.endsWith("/supervisor_question") ||
    normalized.endsWith("__supervisor_question")
  );
};

export function makeRunWriteClaimControl(dependencies: RunContext) {
  const { records, writerPools, withLock, publish, requireRecord, sendPeerNotices } = dependencies;

  const normalizePaths = (paths: ReadonlyArray<string>) => {
    const normalized = normalizeWriteClaims(paths);
    return normalized.ok
      ? Effect.succeed(normalized.claims)
      : Effect.fail(invalid(normalized.code, normalized.message));
  };

  /** Under the lock: the writer, with its cwd, once its claims may change. */
  const claimChangeTarget = (id: string) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(id);
      const { canonicalWriterCwd: cwd, writerPool: pool } = record;
      if (record.view.writeIntent !== "writer" || !cwd || !pool)
        return yield* invalid(
          "write_claims_unavailable",
          `Subagent ${id} is not an active writer with shared-cwd ownership.`,
        );
      if (record.view.writeClaims === undefined)
        return yield* invalid(
          "exclusive_writer_claims_immutable",
          `Subagent ${id} was launched as an exclusive writer; stop it and relaunch with writes to use cooperative claims.`,
        );
      const hasOtherActiveTool = [...record.activeTools.values()].some(
        (toolName) => !isBlockingClaimQuestionTool(toolName),
      );
      const waitingForParentClaimDecision =
        record.view.state === "waiting_for_parent" && !pool.admissionPaused && !hasOtherActiveTool;
      const confirmedPausedViolationOffender =
        record.view.state === "paused" &&
        pool.state === "held" &&
        pool.admissionPaused &&
        pool.violationRunIds.has(id) &&
        record.activeTools.size === 0 &&
        !record.pauseRequested &&
        record.pauseOutcome === undefined &&
        record.pausedAssignmentEpoch === record.assignment.epoch;
      if (!waitingForParentClaimDecision && !confirmedPausedViolationOffender)
        return yield* invalid(
          "write_claim_change_not_waiting",
          `Subagent ${id} must be blocked on a parent claim question or be the confirmed paused claim-violation offender, with no other active tool, before its claims can change.`,
        );
      return { record, cwd };
    });

  /** Normalizes `paths`, commits the claims `next` returns under the lock, then notifies peers. */
  const changeClaims = (
    id: string,
    paths: ReadonlyArray<string>,
    next: (
      current: ReadonlyArray<string>,
      requested: ReadonlyArray<string>,
      record: RunRecord,
      cwd: CanonicalWriterCwd,
    ) => Effect.Effect<ReadonlyArray<string>, SubagentError>,
  ): Effect.Effect<SubagentRunView, SubagentError> =>
    Effect.gen(function* () {
      const requested = yield* normalizePaths(paths);
      const view = yield* withLock(
        Effect.gen(function* () {
          const { record, cwd } = yield* claimChangeTarget(id);
          const claims = yield* next(record.view.writeClaims ?? [], requested, record, cwd);
          record.view = { ...record.view, writeClaims: claims };
          yield* publish;
          return snapshotView(record.view);
        }),
      );
      yield* sendPeerNotices(id);
      return view;
    });

  const grant = (id: string, paths: ReadonlyArray<string>) =>
    changeClaims(id, paths, (current, additions, record, cwd) =>
      Effect.gen(function* () {
        const combined = [
          ...current,
          ...additions.filter((path) => !writeClaimContains(current, path)),
        ];
        if (combined.length > MAX_WRITE_CLAIMS)
          return yield* invalid(
            "too_many_write_claims",
            `A writer may claim at most ${MAX_WRITE_CLAIMS} files.`,
          );
        // The pause a confirmed offender caused on its own pool doesn't block its repair.
        const pools =
          record.view.state === "paused" && record.writerPool?.violationRunIds.has(id)
            ? new Map()
            : writerPools;
        const conflict = writerConflictError(records, pools, cwd, combined, record);
        if (conflict) return yield* conflict;
        return combined;
      }),
    );

  const revoke = (id: string, paths: ReadonlyArray<string>) =>
    changeClaims(id, paths, (current, removals) =>
      Effect.gen(function* () {
        const missing = removals.find((path) => !writeClaimContains(current, path));
        if (missing)
          return yield* invalid(
            "write_claim_not_owned",
            `Subagent ${id} does not claim ${missing}.`,
          );
        const remaining = current.filter((existing) => !writeClaimContains(removals, existing));
        if (remaining.length === 0)
          return yield* invalid(
            "write_claims_cannot_be_empty",
            `Subagent ${id} must retain at least one claim while it remains active. Stop it instead.`,
          );
        return remaining;
      }),
    );

  const resumeAdmission = (id: string): Effect.Effect<SubagentRunView, SubagentError> =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        const canonicalCwd = record.canonicalWriterCwd;
        const pool =
          record.writerPool ?? (canonicalCwd ? writerPools.get(canonicalCwd.digest) : undefined);
        if (!pool)
          return yield* invalid(
            "writer_pool_unavailable",
            `Subagent ${id} has no paused writer-pool admission for its cwd.`,
          );
        if (pool.state === "failed" || pool.state === "quarantined" || pool.state === "releasing")
          return yield* invalid(
            "writer_pool_quarantined",
            "Writer admission cannot resume while cleanup or lease ownership is uncertain.",
          );
        if (!pool.admissionPaused)
          return yield* invalid(
            "writer_admission_not_paused",
            "Writer admission is not paused for this cwd.",
          );
        const uncontained = [...pool.violationRunIds]
          .map((runId) => records.get(runId))
          .find(
            (offender) =>
              offender !== undefined &&
              (offender.cleanupPending ||
                (offender.view.state !== "paused" && !isTerminalRunState(offender.view.state))),
          );
        if (uncontained)
          return yield* invalid(
            "write_violation_containment_pending",
            `Writer ${uncontained.view.id} has not confirmed interruption or cleanup yet.`,
          );
        pool.admissionPaused = false;
        pool.violationRunIds.clear();
        pool.pauseReason = undefined;
        for (const member of records.values()) {
          if (member.canonicalWriterCwd?.digest !== pool.cwd.digest) continue;
          member.writeViolationContainmentStarted = false;
          if (member.view.writeAdmissionPaused || member.view.writeViolationOffender)
            member.view = {
              ...member.view,
              writeAdmissionPaused: undefined,
              writeViolationOffender: undefined,
            };
        }
        if (pool.state === "paused" && pool.members.size === 0) {
          if (writerPools.get(pool.cwd.digest) === pool) writerPools.delete(pool.cwd.digest);
        }
        yield* publish;
        return snapshotView(record.view);
      }),
    );

  return { grant, revoke, resumeAdmission };
}
