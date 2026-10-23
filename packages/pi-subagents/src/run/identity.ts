import { synchronousRandomToken } from "pi-cosmic-core/platform/native-crypto";

// 48 random bits as 10 fixed-width base-36 digits, so a counter appended after it stays unambiguous.
const PROCESS_PREFIX = synchronousRandomToken();
let nextRuntimeOrdinal = 1;

/**
 * A namespace for one runtime's internal tokens. The counter keeps runtimes in one process
 * distinct, and the process-random prefix keeps them from colliding with another process's.
 */
export const allocateRuntimeNamespace = (): string =>
  `r${PROCESS_PREFIX}${(nextRuntimeOrdinal++).toString(36)}`;

export function identityAllocators(runtimeNamespace: string) {
  let nextRunOrdinal = 1;
  const ordinalTokens = (kind: string) => {
    let next = 1;
    return (): string => `${kind}-${runtimeNamespace}-${next++}`;
  };
  // Run IDs are random so a model can't predict the next one and address it before its start
  // returns; the ordinal only numbers default names.
  const allocateRunIdentity = (requestedName: string, taken: (id: string) => boolean) => {
    const ordinal = nextRunOrdinal++;
    let id = `agent-${synchronousRandomToken()}`;
    while (taken(id)) id = `agent-${synchronousRandomToken()}`;
    return { id, name: requestedName || `subagent-${ordinal}` };
  };
  return {
    allocateClaimToken: ordinalTokens("completion"),
    allocateAssignmentAttemptToken: ordinalTokens("assignment"),
    allocateMessageId: ordinalTokens("message"),
    allocateRunIdentity,
  };
}
