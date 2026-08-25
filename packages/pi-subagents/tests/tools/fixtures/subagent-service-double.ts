import * as Effect from "effect/Effect";
import {
  InvalidSubagentRequestError,
  type SubagentNotFoundError,
} from "../../../src/run/errors.ts";
import type { SubagentRunObservation, SubagentServiceContract } from "../../../src/run/service.ts";

type ObservationMethods = Pick<
  SubagentServiceContract,
  | "startSessionOwned"
  | "startRetrySessionOwned"
  | "claimRetryContinuation"
  | "releaseRetryClaim"
  | "exhaustRetryClaim"
  | "blockRetryClaim"
  | "withAwaitTerminalObservations"
  | "withStatusObservations"
  | "consumeCompletions"
  | "grantWriteClaims"
  | "revokeWriteClaims"
  | "resumeWriterAdmission"
>;

export type SubagentServiceDoubleInput = Omit<SubagentServiceContract, keyof ObservationMethods> &
  Partial<ObservationMethods> & {
    /** Optional per-run observation seed used to derive `withStatusObservations`. */
    readonly observeStatus?: (
      id: string,
    ) => Effect.Effect<SubagentRunObservation, SubagentNotFoundError>;
  };

/**
 * Completes a `SubagentServiceContract` test double.
 *
 * The observation methods are required on the production shape. Doubles that only care about the
 * plain run methods get faithful derivations here instead of the tool re-implementing fallbacks.
 */
export function subagentServiceDouble(base: SubagentServiceDoubleInput): SubagentServiceContract {
  const startSessionOwned: SubagentServiceContract["startSessionOwned"] =
    base.startSessionOwned ?? base.start;
  const startRetrySessionOwned: SubagentServiceContract["startRetrySessionOwned"] =
    base.startRetrySessionOwned ?? base.start;
  const claimRetryContinuation: SubagentServiceContract["claimRetryContinuation"] =
    base.claimRetryContinuation ??
    ((id) =>
      Effect.fail(
        new InvalidSubagentRequestError({
          code: "retry_route_unavailable",
          message: `No retry continuation fixture for ${id}.`,
        }),
      ));
  const releaseRetryClaim: SubagentServiceContract["releaseRetryClaim"] =
    base.releaseRetryClaim ?? (() => Effect.void);
  const exhaustRetryClaim: SubagentServiceContract["exhaustRetryClaim"] =
    base.exhaustRetryClaim ?? (() => Effect.void);
  const blockRetryClaim: SubagentServiceContract["blockRetryClaim"] =
    base.blockRetryClaim ?? (() => Effect.void);
  const observeStatus =
    base.observeStatus ??
    ((id: string) => base.status(id).pipe(Effect.map((run): SubagentRunObservation => ({ run }))));
  const consumeCompletions: SubagentServiceContract["consumeCompletions"] =
    base.consumeCompletions ?? (() => Effect.void);
  const withStatusObservations: SubagentServiceContract["withStatusObservations"] =
    base.withStatusObservations ??
    ((ids, use) =>
      Effect.forEach(
        ids,
        (id) =>
          observeStatus(id).pipe(
            Effect.match({
              onFailure: () => ({ missingId: id }) as const,
              onSuccess: (observation) => ({ observation }) as const,
            }),
          ),
        { concurrency: 8 },
      ).pipe(
        Effect.flatMap((outcomes) =>
          use({
            observations: outcomes.flatMap((outcome) =>
              "observation" in outcome ? [outcome.observation] : [],
            ),
            missingIds: outcomes.flatMap((outcome) =>
              "missingId" in outcome ? [outcome.missingId] : [],
            ),
          }),
        ),
      ));
  const grantWriteClaims: SubagentServiceContract["grantWriteClaims"] =
    base.grantWriteClaims ?? ((id) => base.status(id));
  const revokeWriteClaims: SubagentServiceContract["revokeWriteClaims"] =
    base.revokeWriteClaims ?? ((id) => base.status(id));
  const resumeWriterAdmission: SubagentServiceContract["resumeWriterAdmission"] =
    base.resumeWriterAdmission ?? ((id) => base.status(id));
  const withAwaitTerminalObservations: SubagentServiceContract["withAwaitTerminalObservations"] =
    base.withAwaitTerminalObservations ??
    ((ids, until, onUpdate, use) =>
      base
        .awaitTerminal(ids, until, onUpdate)
        .pipe(Effect.flatMap((runs) => use(runs.map((run): SubagentRunObservation => ({ run }))))));
  return {
    ...base,
    startSessionOwned,
    startRetrySessionOwned,
    claimRetryContinuation,
    releaseRetryClaim,
    exhaustRetryClaim,
    blockRetryClaim,
    consumeCompletions,
    grantWriteClaims,
    revokeWriteClaims,
    resumeWriterAdmission,
    withStatusObservations,
    withAwaitTerminalObservations,
  };
}
