import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/** Fresh idle session; descriptor copying leaves hostile accessors unevaluated. */
export function defaultAgentSession<Overrides extends object>(overrides: Overrides) {
  const defaults = {
    sessionFile: undefined,
    messages: [],
    isStreaming: false,
    getActiveToolNames: vi.fn(() => []),
    getToolDefinition: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn(() => Promise.resolve(undefined)),
    steer: vi.fn(() => Promise.resolve(undefined)),
    followUp: vi.fn(() => Promise.resolve(undefined)),
    abort: vi.fn(() => Promise.resolve(undefined)),
    dispose: vi.fn(),
  };
  const session: unknown = Object.defineProperties(
    defaults,
    Object.getOwnPropertyDescriptors(overrides),
  );
  // SAFETY: Overrides retain their property descriptors, including scenario-owned getters.
  return agentSessionFixture(session as Omit<typeof defaults, keyof Overrides> & Overrides);
}

/** Marks a deliberately partial AgentSession test double while retaining its exact fixture type. */
export const agentSessionFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & AgentSession => {
  // SAFETY: Callers construct scenario-specific doubles and exercise only their implemented members.
  return fixture as Fixture & AgentSession;
};
