import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Marks a deliberately partial AgentSession test double while retaining its exact fixture type. */
export const agentSessionFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & AgentSession => {
  // SAFETY: Callers construct scenario-specific doubles and exercise only their implemented members.
  return fixture as Fixture & AgentSession;
};
