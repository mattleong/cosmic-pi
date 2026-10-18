let nextRuntimeNamespace = 1;
export const allocateRuntimeNamespace = (): string => `r${(nextRuntimeNamespace++).toString(36)}`;

export function identityAllocators(runtimeNamespace: string) {
  let nextRunOrdinal = 1;
  const ordinalTokens = (kind: string) => {
    let next = 1;
    return (): string => `${kind}-${runtimeNamespace}-${next++}`;
  };
  const runIdPrefix = `agent-${runtimeNamespace}-`;
  const allocateRunIdentity = (requestedName: string) => {
    const ordinal = nextRunOrdinal++;
    return { id: `${runIdPrefix}${ordinal}`, name: requestedName || `subagent-${ordinal}` };
  };
  return {
    allocateClaimToken: ordinalTokens("completion"),
    allocateRetryClaimToken: ordinalTokens("retry"),
    allocateAssignmentAttemptToken: ordinalTokens("assignment"),
    allocateMessageId: ordinalTokens("message"),
    allocateRunIdentity,
  };
}
