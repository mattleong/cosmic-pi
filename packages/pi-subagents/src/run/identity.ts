import * as Effect from "effect/Effect";

let nextRuntimeNamespace = 1;
export const allocateRuntimeNamespace = (): string => `r${(nextRuntimeNamespace++).toString(36)}`;

export function makeRunIdentities(runtimeNamespace: string) {
  let nextRunOrdinal = 1;
  const ordinalTokens = (kind: string) => {
    let next = 1;
    return (): string => `${kind}-${runtimeNamespace}-${next++}`;
  };
  const runIdPrefix = `agent-${runtimeNamespace}-`;
  const allocateRunIdentity = (requestedName: string, reservedId?: string) => {
    if (reservedId !== undefined)
      return {
        id: reservedId,
        name: requestedName || `subagent-${reservedId.slice(runIdPrefix.length)}`,
      };
    const ordinal = nextRunOrdinal++;
    return { id: `${runIdPrefix}${ordinal}`, name: requestedName || `subagent-${ordinal}` };
  };
  const reserveRunId = Effect.sync(() => `${runIdPrefix}${nextRunOrdinal++}`);
  const isAllocatedRunId = (id: string): boolean => {
    const ordinal = Number(id.slice(runIdPrefix.length));
    return (
      id === `${runIdPrefix}${ordinal}` &&
      Number.isSafeInteger(ordinal) &&
      ordinal >= 1 &&
      ordinal < nextRunOrdinal
    );
  };
  return {
    allocateClaimToken: ordinalTokens("completion"),
    allocateRetryClaimToken: ordinalTokens("retry"),
    allocateAssignmentAttemptToken: ordinalTokens("assignment"),
    allocateRunIdentity,
    reserveRunId,
    isAllocatedRunId,
  };
}
