import type { SubagentProjection, SubagentRunView } from "../../src/run/model.ts";
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
  host: "local",
  runtime: "pi",
  closeOnReport: true,
  reportGeneration: 0,
  assignmentEpoch: 1,
  capabilities: [
    "steer",
    "interrupt",
    "resume",
    "rename-display",
    "parent-contact",
    "peer-notice",
    "native-fork",
  ],
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

export const violationAudit = (path: string, observedAt = 2) => ({
  observedFileWrites: [path],
  violations: [{ path, toolName: "edit", observedAt }],
  bashWriteHints: 0,
});

export const containedWriter = (overrides: Partial<SubagentRunView> = {}) =>
  view({
    writeIntent: "writer",
    writeClaims: ["src/a.ts"],
    writeAdmissionPaused: true,
    writeViolationOffender: true,
    writeAudit: violationAudit("src/b.ts"),
    ...overrides,
  });
