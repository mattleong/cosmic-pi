import type { SubagentProjection, SubagentRunView } from "../../src/run/model.ts";

/** A running local Pi run view; tests override only the fields they assert. */
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

/** A revision-1 projection of `runs` under the root session, which parents the unparented runs. */
export const projectionOf = (runs: ReadonlyArray<SubagentRunView>): SubagentProjection => ({
  revision: 1,
  root: {
    id: "root",
    depth: 0,
    directChildCount: runs.filter((run) => !run.parentRunId || run.parentRunId === "root").length,
    descendantCount: runs.length,
  },
  runs,
});

export const violationAudit = (path: string, observedAt = 2) => ({
  observedFileWrites: [path],
  violations: [{ path, toolName: "edit", observedAt }],
  bashWriteHints: 0,
});

/** A writer whose out-of-claim edit made it the current containment offender. */
export const containedWriter = (overrides: Partial<SubagentRunView> = {}) =>
  view({
    writeIntent: "writer",
    writeClaims: ["src/a.ts"],
    writeAdmissionPaused: true,
    writeViolationOffender: true,
    writeAudit: violationAudit("src/b.ts"),
    ...overrides,
  });
