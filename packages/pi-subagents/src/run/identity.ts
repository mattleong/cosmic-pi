import { synchronousRandomHex } from "pi-cosmic-core";

// 48 random bits as 10 fixed-width base-36 digits, so a counter appended after it stays unambiguous.
const PROCESS_PREFIX = Number.parseInt(synchronousRandomHex(6), 16).toString(36).padStart(10, "0");
let nextRuntimeOrdinal = 1;

/**
 * A namespace for one runtime's IDs. The counter keeps runtimes in one process distinct, and the
 * process-random prefix keeps them from colliding with another process's.
 */
export const allocateRuntimeNamespace = (): string =>
  `r${PROCESS_PREFIX}${(nextRuntimeOrdinal++).toString(36)}`;

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
    allocateAssignmentAttemptToken: ordinalTokens("assignment"),
    allocateMessageId: ordinalTokens("message"),
    allocateRunIdentity,
  };
}
