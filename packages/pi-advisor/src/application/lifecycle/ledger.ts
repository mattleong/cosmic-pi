import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADVISOR_CHECKPOINT_ENTRY_TYPE, createCheckpointLedger } from "../../checkpoint/ledger.ts";
import { exportAdvisorEmissionRecords } from "../../review/emission-guard.ts";
import { UNREADABLE_PARENT_ANCHOR, type ParentAnchor } from "../controller-types.ts";
import type { AdvisorApplicationState } from "../state.ts";
import type { SessionRefs } from "./session-refs.ts";

export const makeLedgerPersistence = (options: {
  readonly pi: ExtensionAPI;
  readonly refs: SessionRefs;
  readonly getState: () => AdvisorApplicationState;
  readonly fingerprint: () => string;
  readonly parentAnchor: (ctx: ExtensionContext) => ParentAnchor;
}) => {
  const persistLedger = (anchor: ParentAnchor): void => {
    if (
      !anchor ||
      anchor === UNREADABLE_PARENT_ANCHOR ||
      typeof options.pi.appendEntry !== "function"
    )
      return;
    const state = options.getState();
    const pending = state.pendingPersistentRecovery;
    try {
      options.pi.appendEntry(
        ADVISOR_CHECKPOINT_ENTRY_TYPE,
        createCheckpointLedger({
          fingerprint: options.fingerprint(),
          anchorId: anchor,
          reviewSummary: options.refs.latestDurableSummary,
          cancellationLatched: state.routing.cancellationLatched,
          completedPrimaryTurns: state.routing.completedPrimaryTurns,
          immunityUntilCompletedTurn: state.routing.immunityUntilCompletedTurn,
          interventionBudget: pending
            ? {
                ...pending.budgetBefore,
                correctionUsed: true,
              }
            : state.interventionBudget,
          findingLifecycle: state.findingLifecycle.records,
          emissionHashes: exportAdvisorEmissionRecords(state.emissionGuard).filter(
            (record) => !pending || !record.endsWith(`:${pending.emission.hash}`),
          ),
        }),
      );
    } catch {
      // Parent persistence is fail-open and cannot own runtime cleanup.
    }
  };

  return {
    persistLedger,
    persistCurrentLedger: (ctx: ExtensionContext): void => persistLedger(options.parentAnchor(ctx)),
  };
};
