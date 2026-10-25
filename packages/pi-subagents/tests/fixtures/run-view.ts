import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { SubagentProjection, SubagentRunView } from "../../src/run/model.ts";

/** A distinct run ID in the minted `agent-<10 base-36 digits>` shape. */
export const runIdFixture = (index: number): string =>
  `agent-${Fn.pipe(`${index}`, Str.padStart(10, "0"))}`;

export const view = (overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id: "agent-1",
  name: "auth-review",
  task: "Review auth",
  selection: {
    source: "profile-candidate",
    reason: "Profile model selection.",
    skippedCandidates: [],
  },
  cwd: "/project",
  state: "running",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  reportGeneration: 0,
  assignmentEpoch: 1,
  capabilities: ["steer", "interrupt", "resume", "parent-contact", "peer-notice", "native-fork"],
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  startedAt: 1,
  lastActivityAt: 1,
  sessionEvents: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  ...overrides,
});

export const projectionOf = (runs: ReadonlyArray<SubagentRunView>): SubagentProjection => ({
  revision: 1,
  runs,
});
