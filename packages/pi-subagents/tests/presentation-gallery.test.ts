import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  writeGallerySection,
  type GalleryMessageScenario,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { withCodePreviewShell } from "pi-code-previews";
import { synchronousNow } from "pi-cosmic-core";
import {
  defineTool,
  initTheme,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Type } from "typebox";
import type { ActivityItem, ActivityPhase } from "pi-cosmic-ui/activity";
import { activityGalleryFrames } from "pi-cosmic-ui/activity/testing";
import { registerSubagentMessageRenderers } from "../src/application/messages.ts";
import { subagentActivityDetail, subagentActivityItems } from "../src/ui/run-activity.ts";
import { SubagentBackendRegistry } from "../src/backend/service.ts";
import {
  makeHostNotifier,
  type SubagentCompletionNotification,
  type SubagentNotification,
  type SubagentWorkflowNotification,
} from "../src/boundary/host-notifier.ts";
import { subagentResultTool } from "../src/boundary/host-child-result.ts";
import type { DeclaredProfileCandidate, ProfileRouteContinuation } from "../src/profiles/model.ts";
import {
  SubagentProfileService,
  type SubagentProfileServiceContract,
} from "../src/profiles/service.ts";
import {
  InvalidSubagentRequestError,
  SubagentNotFoundError,
  SubagentProcessError,
  UnsupportedSubagentCapabilityError,
} from "../src/run/errors.ts";
import type { StartSubagentRequest, SubagentRunView } from "../src/run/model.ts";
import { scriptedWriterAdmissionError } from "../src/run/launch-policy.ts";
import { SubagentService } from "../src/run/service.ts";
import { makeAwaitDetails, makeStartDetails } from "../src/tools/details.ts";
import {
  CONTACT_PARENT_LABEL,
  contactParentCompactSummary,
  contactParentExpandedContent,
  contactParentRenderers,
} from "../src/tools/render-parent.ts";
import { RESULT_ACCEPTED_TEXT } from "../src/tools/result-presentation.ts";
import { executeSubagentActionEffect, type SubagentToolRuntime } from "../src/tools/execute.ts";
import { makeAwaitExecution } from "../src/tools/execute-await.ts";
import { decodeSubagentOutcomeDetails, marksSubagentToolError } from "../src/tools/outcome.ts";
import { subagentToolAction, type SubagentToolInput } from "../src/tools/schema.ts";
import { registerSubagentTools } from "../src/tools/subagent.ts";
import { registerWorkflowTool, type WorkflowToolRuntime } from "../src/tools/workflow.ts";
import type { WorkflowToolArgs } from "../src/tools/workflow-presentation.ts";
import type { WorkflowAgentAttention } from "../src/workflow/attention.ts";
import {
  emptyWorkflowUsage,
  type WorkflowAgentView,
  type WorkflowRunView,
} from "../src/workflow/model.ts";
import {
  interruptedWorkflowNotification,
  workflowNotification,
} from "../src/workflow/notification.ts";
import {
  parseWorkflowScript,
  workflowPlannedAgents,
  type WorkflowScript,
} from "../src/workflow/script.ts";
import { requireWorkflowArgs } from "../src/workflow/args.ts";
import { WORKFLOW_BUDGET_REASON } from "../src/workflow/budget.ts";
import { WORKFLOW_BUDGET_ERROR } from "../src/workflow/prelude.ts";
import { WorkflowNotFoundError } from "../src/workflow/errors.ts";
import type { WorkflowRecordedRun } from "../src/workflow/run-record.ts";
import {
  WorkflowService,
  type WorkflowServiceContract,
  type WorkflowStatus,
  type WorkflowToolStatus,
} from "../src/workflow/service.ts";
import { WorkflowStore } from "../src/workflow/store.ts";
import type { WorkspaceRecord } from "../src/workspace/model.ts";
import { extensionApiFixture } from "./fixtures/pi-host.ts";
import { containedWriter, view, workflowAgentView, workflowRunView } from "./fixtures/run-view.ts";
import {
  subagentServiceDouble,
  type SubagentServiceDoubleInput,
} from "./tools/fixtures/subagent-service-double.ts";
import {
  context,
  fallbackProfileService,
  profileServiceFor,
  testBackendRegistry,
} from "./tools/fixtures/tool-harness.ts";

type ToolScenario = GalleryScenario & { readonly tool: string };
type GalleryResult = NonNullable<GalleryScenario["result"]>;
type GalleryMessage = GalleryMessageScenario["message"];

const runtime: SubagentToolRuntime = {
  environment: { cwd: "/project", projectTrusted: false },
  run: () => Promise.reject(new Error("Rendering must not execute")),
  startUiTicker: () => () => undefined,
  toolPresentation: {
    beginStart: () => () => undefined,
    beginAwait: () => () => undefined,
    isLiveHierarchyAvailable: () => false,
  },
};

// ─── Worker fleet ────────────────────────────────────────────────────────────

const now = synchronousNow();
const timing = (startedMinutesAgo: number, endedMinutesAgo?: number) => ({
  startedAt: now - startedMinutesAgo * 60_000,
  lastActivityAt: now - (endedMinutesAgo ?? 0.1) * 60_000,
  ...(endedMinutesAgo !== undefined && { endedAt: now - endedMinutesAgo * 60_000 }),
});
const usage = (totalTokens: number, cost: number) => ({
  input: Math.round(totalTokens * 0.7),
  output: Math.round(totalTokens * 0.05),
  cacheRead: Math.round(totalTokens * 0.25),
  cacheWrite: 0,
  totalTokens,
  cost,
});

const authReview = view({
  id: "agent-1",
  name: "auth-review",
  task: "Review the session refresh flow in src/auth",
  profile: "reviewer",
  progress: "Checking token refresh in src/auth/session.ts",
  currentTool: "read",
  directChildCount: 1,
  descendantCount: 1,
  usage: usage(84_200, 0.61),
  ...timing(4),
});
const docsSweep = view({
  id: "agent-2",
  name: "docs-sweep",
  task: "Find stale refreshToken references in docs",
  profile: "scout",
  effort: "low",
  state: "completed",
  finalText:
    "Found 3 stale references to `refreshToken()`:\n\n- docs/auth.md:42\n- docs/auth.md:88\n- README.md:120",
  usage: usage(21_900, 0.08),
  ...timing(6, 1),
});
const apiAudit = view({
  id: "agent-3",
  name: "api-audit",
  task: "Audit the public API surface for breaking changes",
  profile: "researcher",
  host: "local",
  runtime: "codex",
  model: "gpt-5.5",
  effort: "medium",
  closeOnReport: true,
  state: "completed",
  reportGeneration: 1,
  capabilities: ["steer", "interrupt", "parent-contact"],
  finalText: "No breaking changes in the public API since v0.1.",
  usage: usage(40_300, 0.22),
  ...timing(9, 2),
});
const schemaCheck = view({
  id: "agent-4",
  name: "schema-check",
  task: "Compare migrations against schema.prisma",
  profile: "scout",
  parentRunId: "agent-1",
  depth: 2,
  progress: "Comparing migrations against schema.prisma",
  ...timing(2),
});
const migrationReview = view({
  id: "agent-5",
  name: "migration-review",
  task: "Review db/0007.sql",
  profile: "reviewer",
  state: "failed",
  error: "Error: 429 Too Many Requests: rate limit exceeded\n    at Client.request",
  remainingCandidateCount: 1,
  selection: {
    source: "profile-candidate",
    reason: "Profile model selection.",
    candidateIndex: 0,
    skippedCandidates: [],
  },
  ...timing(3, 2),
});
const dbMigration = view({
  id: "agent-6",
  name: "db-migration",
  task: "Implement the 0007 migration",
  profile: "worker",
  writeIntent: "writer",
  writeClaims: ["db/0007.sql", "src/db/schema.ts"],
  state: "waiting_for_parent",
  question: {
    requestId: "q-1",
    message: "src/db/seed.ts also needs the new column. May I claim it?",
  },
  ...timing(5),
});
const apiWriter = containedWriter({
  id: "agent-9",
  name: "api-writer",
  profile: "worker",
  state: "paused",
});

const fleet = new Map(
  [authReview, docsSweep, apiAudit, schemaCheck, migrationReview, dbMigration, apiWriter].map(
    (run) => [run.id, run],
  ),
);
const lookup = (id: string): Effect.Effect<SubagentRunView, SubagentNotFoundError> => {
  const run = fleet.get(id);
  return run
    ? Effect.succeed(run)
    : Effect.fail(new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` }));
};
const updated = (id: string, overrides: Partial<SubagentRunView>) =>
  lookup(id).pipe(Effect.map((run) => ({ ...run, ...overrides })));

// ─── Real execution through the tool's own execute and present path ─────────

const hostApi = extensionApiFixture({
  getThinkingLevel: () => "high",
  getActiveTools: () => ["read"],
});

interface Execution {
  readonly service?: SubagentServiceDoubleInput;
  readonly profiles?: SubagentProfileServiceContract;
  readonly onUpdate?: AgentToolUpdateCallback<unknown>;
  readonly scripted?: boolean;
}

// A text-only result: Pi turns a rejected execution into this, and child receipts share its shape.
const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});

/** Runs one call like the registered tool, marking errors as Pi's receipt hook does. */
const execute = (input: SubagentToolInput, options: Execution = {}) =>
  executeSubagentActionEffect(
    hostApi,
    runtime.environment,
    input,
    options.onUpdate,
    context,
    undefined,
    undefined,
    options.scripted,
  ).pipe(
    Effect.map((result) => {
      const details = decodeSubagentOutcomeDetails(subagentToolAction(input), result.details);
      return { result, isError: details !== undefined && marksSubagentToolError(details) };
    }),
    Effect.catch((error) => Effect.succeed({ result: textResult(error.message), isError: true })),
    Effect.provideService(SubagentService, subagentServiceDouble(options.service ?? {})),
    Effect.provideService(SubagentProfileService, options.profiles ?? fallbackProfileService),
    Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
  );

const scenario = (title: string, input: SubagentToolInput, options: Execution = {}) =>
  execute(input, options).pipe(
    Effect.map(
      (executed): ToolScenario => ({ tool: input.tool, title, args: input.args, ...executed }),
    ),
  );

const launched = (request: StartSubagentRequest, id: string) =>
  view({
    id,
    name: request.name ?? "subagent",
    task: request.task,
    profile: request.profile,
    host: request.host,
    runtime: request.runtime,
    model: request.model,
    effort: request.effort,
    context: request.context,
    writeIntent: request.writeIntent,
    closeOnReport: request.closeOnReport,
    openaiFastMode: request.openaiFastMode,
    selection: request.selection ?? view().selection,
    ...timing(0),
  });

const startInput: SubagentToolInput<"subagent_start"> = {
  tool: "subagent_start",
  args: {
    agents: [
      { name: "auth-review", profile: "reviewer", task: "Review the session refresh flow" },
      { name: "docs-sweep", profile: "scout", task: "Find stale refreshToken references" },
    ],
  },
};

/** One launch settles while the other waits, so the first receipt is a real partial. */
const startScenarios = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const firstReceipt = yield* Deferred.make<GalleryResult>();
  const launching = yield* Effect.forkChild(
    scenario("two launches start", startInput, {
      service: {
        startSessionOwned: (request) =>
          request.name === "docs-sweep"
            ? Deferred.await(release).pipe(Effect.as(launched(request, "agent-2")))
            : Effect.succeed(launched(request, "agent-1")),
      },
      onUpdate: (update) => {
        Deferred.doneUnsafe(firstReceipt, Effect.succeed(update));
      },
    }),
  );
  const partial = yield* Deferred.await(firstReceipt);
  yield* Deferred.succeed(release, undefined);
  const settled = yield* Fiber.join(launching);
  const still: ToolScenario = {
    tool: startInput.tool,
    title: "one launch still starting",
    args: startInput.args,
    phase: "running",
    result: partial,
  };
  const blockedWriter = yield* scenario(
    "scripted writer launch is returned to the main agent",
    {
      tool: "subagent_start",
      args: {
        agents: [{ profile: "worker", name: "workflow-edit", task: "Implement the change" }],
      },
    },
    { scripted: true },
  );
  const blockedDescendant = yield* scenario(
    "workflow descendant cannot delegate writer work",
    {
      tool: "subagent_start",
      args: {
        agents: [{ profile: "worker", name: "delegated-edit", task: "Implement the change" }],
      },
    },
    { service: { startSessionOwned: () => Effect.fail(scriptedWriterAdmissionError()) } },
  );
  return [settled, still, blockedWriter, blockedDescendant];
});

const awaitInput: SubagentToolInput<"subagent_await"> = {
  tool: "subagent_await",
  args: { runIds: ["agent-1", "agent-2"], until: "all_finished" },
};

/** The live update and the settled result come from one real await. */
const awaitScenarios = Effect.gen(function* () {
  const updates: GalleryResult[] = [];
  const settled = yield* scenario("both workers report", awaitInput, {
    service: {
      withAwaitTerminalObservations: (_ids, _until, onUpdate, use) =>
        Effect.suspend(() => {
          onUpdate?.([authReview, { ...docsSweep, state: "running", finalText: undefined }]);
          return use([
            {
              run: {
                ...authReview,
                state: "completed" as const,
                finalText: "The refresh flow is safe. One nit: session.ts:118 swallows a timeout.",
                ...timing(4, 0.5),
              },
            },
            { run: docsSweep },
          ]);
        }),
    },
    onUpdate: (update) => {
      updates.push(update);
    },
  });
  const cancellation = makeAwaitExecution(awaitInput.args.runIds, "all_finished");
  cancellation.update([authReview, docsSweep]);
  const live: ToolScenario = {
    tool: awaitInput.tool,
    title: "live progress",
    args: awaitInput.args,
    phase: "running",
    result: updates[0],
  };
  const cancelled: ToolScenario = {
    tool: awaitInput.tool,
    title: "waiting cancelled",
    args: awaitInput.args,
    result: cancellation.cancelled(),
  };
  return [live, settled, cancelled];
});

const candidate = (
  overrides: Partial<DeclaredProfileCandidate> = {},
): DeclaredProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  ...overrides,
});
const configuredRoutes = profileServiceFor({
  profiles: {
    reviewer: [candidate({ model: "anthropic/claude-opus-4-7" }), candidate()],
    researcher: [candidate({ model: "google/gemini-3-pro", effort: "medium" })],
    worker: "disabled",
  },
});

const modelScenarios = Effect.all([
  scenario(
    "all profile routes",
    { tool: "subagent_models", args: {} },
    { profiles: configuredRoutes },
  ),
  scenario(
    "one profile route",
    { tool: "subagent_models", args: { profile: "reviewer" } },
    { profiles: configuredRoutes },
  ),
]);

const inspectionScenarios = Effect.all([
  scenario(
    "fleet with a nested worker",
    { tool: "subagent_list", args: {} },
    {
      service: {
        list: Effect.succeed([authReview, schemaCheck, docsSweep, apiAudit, migrationReview]),
      },
    },
  ),
  scenario(
    "no workers",
    { tool: "subagent_list", args: {} },
    { service: { list: Effect.succeed([]) } },
  ),
  scenario(
    "failed worker with a retry option",
    { tool: "subagent_status", args: { runIds: ["agent-5"] } },
    { service: { status: lookup } },
  ),
  scenario(
    "one worker not found",
    { tool: "subagent_status", args: { runIds: ["agent-2", "agent-12"] } },
    { service: { status: lookup } },
  ),
]);

const guidance = "Also check the refresh-token rotation path.";
const messagingScenarios = Effect.all([
  scenario(
    "guidance delivered",
    { tool: "subagent_send", args: { runIds: ["agent-1"], message: guidance } },
    { service: { send: (id) => lookup(id) } },
  ),
  scenario(
    "guidance for a native worker",
    { tool: "subagent_send", args: { runIds: ["agent-3"], message: "Now audit the CLI flags." } },
    { service: { send: (id) => updated(id, { state: "running", finalText: undefined }) } },
  ),
  scenario(
    "delivery awaiting confirmation",
    { tool: "subagent_send", args: { runIds: ["agent-1"], message: guidance } },
    {
      service: {
        send: () =>
          Effect.fail(
            new SubagentProcessError({
              operation: "steer",
              code: "steer_outcome_uncertain",
              pendingDelivery: true,
              message:
                "Claude guidance may have been sent, but native replay acknowledgement is still pending. The run remains running and backend-owned; do not resend. Await or inspect status; stop remains available.",
            }),
          ),
      },
    },
  ),
  scenario(
    "worker waiting for a reply",
    { tool: "subagent_send", args: { runIds: ["agent-6", "agent-1"], message: guidance } },
    {
      service: {
        send: (id) =>
          id === "agent-6"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "run_waiting_for_parent",
                  message: `Subagent ${id} is waiting for a parent reply; use subagent_reply({ runId: "${id}", message: "..." }).`,
                }),
              )
            : lookup(id),
      },
    },
  ),
  scenario(
    "reply delivered",
    { tool: "subagent_reply", args: { runId: "agent-6", message: "Yes, claim src/db/seed.ts." } },
    { service: { reply: (id) => updated(id, { state: "running", question: undefined }) } },
  ),
  scenario(
    "no pending question",
    { tool: "subagent_reply", args: { runId: "agent-1", message: "Yes, go ahead." } },
    {
      service: {
        reply: (id) =>
          Effect.fail(
            new InvalidSubagentRequestError({
              code: "parent_question_missing",
              message: `Subagent ${id} has no pending parent question.`,
            }),
          ),
      },
    },
  ),
  scenario(
    "reply unconfirmed",
    { tool: "subagent_reply", args: { runId: "agent-6", message: "Yes, claim src/db/seed.ts." } },
    {
      service: {
        reply: (id) =>
          Effect.fail(
            new SubagentProcessError({
              operation: "reply",
              code: "reply_outcome_uncertain",
              message: `The reply to subagent ${id} may already have applied. Inspect with subagent_status before retrying. (Transport closed before acknowledgement.)`,
            }),
          ),
      },
    },
  ),
]);

const retryRoute: ProfileRouteContinuation = {
  profile: "reviewer",
  routeSource: "global",
  candidates: [candidate({ model: "anthropic/claude-opus-4-7" }), candidate()].map((entry) => ({
    ...entry,
    openaiFastMode: false,
    closeOnReport: true,
  })),
  selectedCandidateIndex: 0,
  skippedCandidates: [],
};

const lifecycleScenarios = Effect.all([
  scenario(
    "retry on the next profile option",
    { tool: "subagent_lifecycle", args: { action: "retry", runIds: ["agent-5"] } },
    {
      service: {
        claimRetryContinuation: (id) =>
          lookup(id).pipe(
            Effect.map((source) => ({ source, continuation: retryRoute, claimToken: "claim-1" })),
          ),
        releaseRetryClaim: () => Effect.void,
        startRetrySessionOwned: (request, onOwned) =>
          Effect.sync(() => {
            onOwned?.();
            return {
              ...launched(request, "agent-7"),
              name: "migration-review",
              predecessorRunId: request.supersedes?.runId,
            };
          }),
      },
    },
  ),
  scenario(
    "retry with no options left",
    { tool: "subagent_lifecycle", args: { action: "retry", runIds: ["agent-5"] } },
    {
      service: {
        claimRetryContinuation: () =>
          Effect.fail(
            new InvalidSubagentRequestError({
              code: "retry_route_exhausted",
              message:
                "Profile reviewer has no configured candidate after candidate 2. Only now may the parent choose a generalist replacement.",
            }),
          ),
      },
    },
  ),
  scenario(
    "stop two workers",
    { tool: "subagent_lifecycle", args: { action: "stop", runIds: ["agent-1", "agent-4"] } },
    {
      service: {
        stop: (id) => updated(id, { state: id === "agent-4" ? "stopping" : "stopped" }),
      },
    },
  ),
  scenario(
    "stop a missing worker",
    { tool: "subagent_lifecycle", args: { action: "stop", runIds: ["agent-1", "agent-12"] } },
    { service: { stop: (id) => updated(id, { state: "stopped" }) } },
  ),
  scenario(
    "interrupt",
    { tool: "subagent_lifecycle", args: { action: "interrupt", runIds: ["agent-1"] } },
    { service: { interrupt: (id) => updated(id, { state: "paused" }) } },
  ),
  scenario(
    "resume with guidance",
    {
      tool: "subagent_lifecycle",
      args: {
        action: "resume",
        runIds: ["agent-1"],
        message: "Continue with the reviewed guidance.",
      },
    },
    { service: { resume: (id) => updated(id, { state: "running" }) } },
  ),
  scenario(
    "resume unsupported",
    { tool: "subagent_lifecycle", args: { action: "resume", runIds: ["agent-3"] } },
    {
      service: {
        resume: (id) =>
          Effect.fail(
            new UnsupportedSubagentCapabilityError({
              backend: "local/codex",
              capability: "resume",
              message: `local/codex subagents do not support resume. Inspect supported operations with subagent_status({ runIds: ["${id}"] }).`,
            }),
          ),
      },
    },
  ),
  scenario("guidance on a stop is rejected", {
    tool: "subagent_lifecycle",
    args: { action: "stop", runIds: ["agent-1"], message: "Wrap up first." },
  }),
  scenario(
    "rename",
    { tool: "subagent_rename", args: { runId: "agent-1", name: "session-review" } },
    { service: { rename: (id, name) => updated(id, { name }) } },
  ),
]);

const claimsScenarios = Effect.all([
  scenario(
    "inspect claims",
    { tool: "subagent_claims", args: { action: "list", runIds: ["agent-6"] } },
    { service: { status: lookup } },
  ),
  scenario(
    "grant a claim",
    {
      tool: "subagent_claims",
      args: { action: "grant", runId: "agent-6", paths: ["src/db/seed.ts"] },
    },
    {
      service: {
        grantWriteClaims: (id, paths) =>
          lookup(id).pipe(
            Effect.map((run) => ({ ...run, writeClaims: [...(run.writeClaims ?? []), ...paths] })),
          ),
      },
    },
  ),
  scenario(
    "grant refused",
    {
      tool: "subagent_claims",
      args: { action: "grant", runId: "agent-1", paths: ["src/auth/session.ts"] },
    },
    {
      service: {
        grantWriteClaims: (id) =>
          Effect.fail(
            new InvalidSubagentRequestError({
              code: "write_claim_change_not_waiting",
              message: `Subagent ${id} must be blocked on a parent claim question or be the confirmed paused claim-violation offender, with no other active tool, before its claims can change.`,
            }),
          ),
      },
    },
  ),
  scenario(
    "resume writer admission",
    { tool: "subagent_claims", args: { action: "resume_admission", runId: "agent-9" } },
    {
      service: {
        resumeWriterAdmission: (id) =>
          updated(id, { writeAdmissionPaused: undefined, writeViolationOffender: undefined }),
      },
    },
  ),
]);

const diffPage = [
  "diff --git a/db/0007.sql b/db/0007.sql",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/db/0007.sql",
  "@@ -0,0 +1,2 @@",
  "+ALTER TABLE sessions ADD COLUMN rotated_at timestamptz;",
  "+CREATE INDEX sessions_rotated_at ON sessions (rotated_at);",
].join("\n");
const workspaceRecord: WorkspaceRecord = {
  version: 1,
  handle: {
    workspaceId: "ws-1",
    ownerId: "root",
    sourceCwd: "/project",
    sourceRoot: "/project",
    cwd: "/project/.pi-subagents/worktrees/ws-1",
  },
  status: "frozen",
  baseline: "4f2a9c1",
  revision: { revisionId: "rev-1", diff: diffPage, changedPaths: ["db/0007.sql"] },
};
const workspaceService: SubagentServiceDoubleInput = {
  workspaceList: () =>
    Effect.succeed({
      records: [workspaceRecord],
      unavailable: [
        { workspaceId: "ws-9", status: "unavailable", reason: "recovery-record-unavailable" },
      ],
    }),
  workspaceReview: () =>
    Effect.succeed({
      revisionId: "rev-1",
      changedPaths: ["db/0007.sql"],
      diff: diffPage,
      offset: 0,
      totalChars: diffPage.length + 16_000,
      nextOffset: diffPage.length,
    }),
  workspacePrepare: (_workspaceId, revisionId) =>
    Effect.succeed({
      preparationId: "prep-1",
      revisionId,
      cwd: "/project/.pi-subagents/prepared/prep-1",
      leaseDirectories: [],
    }),
  workspaceIntegrate: () =>
    Effect.succeed({
      workerRoot: "/agent/git-workspaces/ws-1/worker",
      uncapturedPaths: [],
      treeRemovalFailed: false,
      leaseReleaseUnconfirmed: false,
    }),
  workspaceDiscard: () => Effect.void,
  workspaceRevise: () =>
    Effect.succeed(
      view({ id: "agent-10", name: "db-migration", profile: "worker", writeIntent: "writer" }),
    ),
};
const leftoverWorkspace: SubagentServiceDoubleInput = {
  workspaceIntegrate: () =>
    Effect.succeed({
      workerRoot: "/agent/git-workspaces/ws-1/worker",
      uncapturedPaths: ["src/Billing/Invoice.cs", "assets/logo.svg"],
      treeRemovalFailed: false,
      leaseReleaseUnconfirmed: true,
    }),
};
const staleWorkspace: SubagentServiceDoubleInput = {
  workspacePrepare: () =>
    Effect.fail(
      new InvalidSubagentRequestError({
        code: "workspace_revision_stale",
        message: "The immutable workspace revision no longer matches.",
      }),
    ),
};

const workspaceScenarios = Effect.all([
  scenario(
    "list proposals",
    { tool: "subagent_workspace", args: { action: "list" } },
    { service: workspaceService },
  ),
  scenario(
    "review the first diff page",
    { tool: "subagent_workspace", args: { action: "review", workspaceId: "ws-1" } },
    { service: workspaceService },
  ),
  scenario(
    "prepare a combined tree",
    {
      tool: "subagent_workspace",
      args: { action: "prepare", workspaceId: "ws-1", revisionId: "rev-1" },
    },
    { service: workspaceService },
  ),
  scenario(
    "integrate",
    {
      tool: "subagent_workspace",
      args: {
        action: "integrate",
        workspaceId: "ws-1",
        revisionId: "rev-1",
        preparationId: "prep-1",
      },
    },
    { service: workspaceService },
  ),
  scenario(
    "integrate leaving files and the source lock behind",
    {
      tool: "subagent_workspace",
      args: {
        action: "integrate",
        workspaceId: "ws-1",
        revisionId: "rev-1",
        preparationId: "prep-1",
      },
    },
    { service: leftoverWorkspace },
  ),
  scenario(
    "request a revision",
    {
      tool: "subagent_workspace",
      args: { action: "revise", workspaceId: "ws-1", message: "Add a down migration." },
    },
    { service: workspaceService },
  ),
  scenario(
    "discard",
    { tool: "subagent_workspace", args: { action: "discard", workspaceId: "ws-1" } },
    { service: workspaceService },
  ),
  scenario(
    "stale revision",
    {
      tool: "subagent_workspace",
      args: { action: "prepare", workspaceId: "ws-1", revisionId: "rev-0" },
    },
    { service: staleWorkspace },
  ),
]);

// ─── Hand-built await and start receipts ─────────────────────────────────────

const awaited = (
  title: string,
  runs: Parameters<typeof makeAwaitDetails>[0]["runs"],
  extra: Partial<Parameters<typeof makeAwaitDetails>[0]> = {},
): ToolScenario => ({
  tool: "subagent_await",
  title,
  args: { runIds: runs.map((run) => run.id), until: "all_finished" },
  result: {
    content: [{ type: "text", text: "Agent-facing await report" }],
    details: makeAwaitDetails({ runs, awaitUntil: "all_finished", ...extra }),
  },
});

const route = {
  profile: "reviewer",
  routeStatus: "selected",
  host: "local",
  runtime: "pi",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  openaiFastMode: false,
} as const;

const receiptScenarios: ReadonlyArray<ToolScenario> = [
  awaited("worker rate limited", [
    view({
      state: "failed",
      error: "Error: 429 Too Many Requests: rate limit exceeded\n    at Client.request",
    }),
  ]),
  awaited("worker stopped", [view({ state: "stopped" })]),
  awaited("worker paused", [view({ state: "paused" })], { attentionRequired: true }),
  awaited(
    "worker asks a question",
    [
      view({
        state: "waiting_for_parent",
        question: {
          requestId: "q-1",
          message:
            "Should I also update the migration in db/0007.sql, or leave it for a follow-up?",
        },
      }),
    ],
    { attentionRequired: true },
  ),
  awaited("writer outside its claims", [containedWriter({ state: "running" })], {
    attentionRequired: true,
  }),
  awaited("worker and system warnings", [
    view({
      state: "completed",
      finalText: "Done.",
      warning: "Could not run the integration tests: docker is not available",
      systemWarning: "Context window 91% full",
    }),
  ]),
  awaited("writer changes ready for review", [
    view({
      state: "completed",
      writeIntent: "writer",
      writerWorkspaceMode: "worktree",
      workspaceId: "ws-1",
      finalText: "Implemented.",
    }),
  ]),
  {
    tool: "subagent_start",
    title: "one launch fails",
    args: {
      agents: [
        { name: "auth-review", task: "Review auth" },
        { name: "docs-sweep", task: "Sweep docs" },
      ],
    },
    isError: true,
    result: {
      content: [{ type: "text" as const, text: "Agent-facing launch report" }],
      details: makeStartDetails({
        startEntries: [
          { ...route, index: 0, name: "auth-review", status: "failed", candidateIndex: 0 },
          {
            ...route,
            index: 1,
            name: "docs-sweep",
            status: "started",
            candidateIndex: 1,
            runId: "agent-2",
            warning:
              "The primary candidate was unavailable; selected the declared local Pi fallback.",
          },
        ],
        startFailures: [
          {
            index: 0,
            name: "auth-review",
            code: "prompt_rejected",
            message: "Prompt rejected: 400 invalid_request_error: messages.0.content is empty",
            admittedRun: {
              runId: "agent-1",
              cleanupDisposition: "confirmed",
              retryDisposition: "eligible",
              remainingCandidateCount: 1,
              hasRemainingCandidate: true,
            },
          },
        ],
      }),
    },
  },
];

// ─── Child tools ─────────────────────────────────────────────────────────────

/**
 * The child bridge registers this inside an activated session as this exact wrapper over its
 * definition and the contact_parent renderers, so the gallery wraps the same ones.
 */
const contactParentTool = () =>
  withCodePreviewShell(
    defineTool({
      ...contactParentRenderers,
      name: "contact_parent",
      label: CONTACT_PARENT_LABEL,
      description: CONTACT_PARENT_LABEL,
      parameters: Type.Object({}),
      execute: () => Promise.reject(new Error("Rendering must not execute")),
    }),
    { compactSummary: contactParentCompactSummary, expandedContent: contactParentExpandedContent },
  );

const progressNote = "Mapped the auth flow; checking token refresh next";
const warningNote = "Integration tests need docker, which isn't available here; skipping them";
const questionNote = "Should the migration also backfill rotated_at for existing sessions?";
const contact = (
  title: string,
  kind: string,
  message: string,
  scenario: Partial<GalleryScenario>,
): ToolScenario => ({ tool: "contact_parent", title, args: { kind, message }, ...scenario });

const parentScenarios: ReadonlyArray<ToolScenario> = [
  contact("progress", "progress", progressNote, {
    result: textResult("Parent received progress."),
  }),
  contact("warning", "warning", warningNote, { result: textResult("Parent received warning.") }),
  contact("question waiting for a reply", "question", questionNote, { phase: "running" }),
  contact("question answered", "question", questionNote, {
    result: textResult("Parent reply: No backfill; leave existing rows null."),
  }),
  contact("question timed out", "question", questionNote, {
    isError: true,
    result: textResult("Parent question timed out without a reply."),
  }),
];

/** The child's private result tool, as registered for a launch with a result contract. */
const resultTool = () =>
  subagentResultTool(
    {
      parameters: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["safe", "unsafe"] },
          findings: { type: "array", items: { type: "string" } },
        },
        required: ["verdict", "findings"],
        additionalProperties: false,
      },
      strictSafe: true,
    },
    () => Promise.reject(new Error("Rendering must not execute")),
  );

const verdict = { verdict: "unsafe", findings: ["session.ts:118 swallows a refresh timeout"] };

const resultScenarios: ReadonlyArray<ToolScenario> = [
  {
    tool: "subagent_result",
    title: "submitting",
    args: verdict,
    phase: "running",
  },
  {
    tool: "subagent_result",
    title: "accepted",
    args: verdict,
    result: textResult(RESULT_ACCEPTED_TEXT),
  },
  {
    tool: "subagent_result",
    title: "rejected by its schema",
    args: { verdict: "risky", findings: [] },
    isError: true,
    result: textResult(
      'Validation failed for tool "subagent_result":\n  - verdict: must be equal to one of the allowed values\n\nReceived arguments:\n{"verdict":"risky","findings":[]}',
    ),
  },
  {
    tool: "subagent_result",
    title: "second result refused",
    args: verdict,
    isError: true,
    result: textResult(
      "A result was already accepted for this run, and the first one is final. Stop now.",
    ),
  },
];

// ─── Dynamic workflows ───────────────────────────────────────────────────────

const reviewScript = `export const meta = {
  name: "review-changes",
  description: "Review the diff by dimension, then verify each finding",
  phases: [{ title: "Review" }, { title: "Verify" }],
};
const found = await parallel(["correctness", "security"].map((area) => () =>
  agent(\`Review the uncommitted diff for \${area} bugs.\`, { phase: "Review", profile: "reviewer" })));
phase("Verify");
return found.filter(Boolean);`;

const workflowRun = (patch: Partial<WorkflowRunView> = {}): WorkflowRunView =>
  workflowRunView({
    id: "wf-mg3k2l-1",
    name: "review-changes",
    description: "Review the diff by dimension, then verify each finding",
    phases: [{ title: "Review" }, { title: "Verify" }],
    currentPhase: "Review",
    state: "running",
    startedAt: now - 3 * 60_000,
    agents: [
      {
        callId: 1,
        runId: "agent-7",
        label: "review:correctness",
        phase: "Review",
        profile: "reviewer",
        state: "completed",
        queuedAt: now - 180_000,
        startedAt: now - 179_000,
        endedAt: now - 60_000,
      },
      {
        callId: 2,
        runId: "agent-8",
        label: "review:security",
        phase: "Review",
        profile: "reviewer",
        state: "running",
        queuedAt: now - 180_000,
        startedAt: now - 179_000,
      },
      {
        callId: 3,
        runId: "agent-9",
        label: "verify:1",
        phase: "Verify",
        profile: "reviewer",
        state: "queued",
        queuedAt: now - 30_000,
        waiting: { kind: "slot" },
      },
    ],
    logs: [{ at: now - 60_000, level: "info", message: "correctness review found 2 findings" }],
    usage: {
      ...emptyWorkflowUsage(),
      input: 152_300,
      output: 4_200,
      cacheRead: 29_900,
      totalTokens: 186_400,
      cost: 0.62,
      toolUses: 41,
    },
    args: { scope: "src/auth" },
    ...patch,
  });

const completedWorkflow = workflowRun({
  id: "wf-mg3k2l-2",
  state: "completed",
  currentPhase: "Verify",
  endedAt: now,
  agents: workflowRun().agents.map((agent) => ({
    ...agent,
    state: "completed" as const,
    endedAt: now,
  })),
  result: {
    text: JSON.stringify(
      [{ file: "src/auth/session.ts", line: 118, claim: "Timeout is swallowed" }],
      null,
      2,
    ),
    clipped: false,
  },
});
/** A script that threw: its running agent was stopped, and its queued one never started. */
const failedWorkflow = workflowRun({
  id: "wf-mg3k2l-3",
  state: "failed",
  endedAt: now,
  agents: workflowRun().agents.map(({ waiting: _waiting, ...agent }) =>
    agent.state === "completed"
      ? agent
      : { ...agent, state: "stopped" as const, reason: "the workflow stopped", endedAt: now },
  ),
  failure: {
    name: "TypeError",
    message: "found.filter is not a function",
    stack: "at <workflow>:9:14",
  },
});
const runtimeFailedWorkflow = workflowRun({
  id: "wf-runtime-1",
  state: "failed",
  endedAt: now,
  agents: [],
  scriptPath: "/home/user/.pi/agent/subagents/workflow-runs/wf-runtime-1/script.js",
  failure: {
    kind: "sandbox",
    name: "Error",
    message: "Cannot find module '/runtime/pi-codemode/dist/runtime/worker.js'",
  },
});
const stoppedWorkflow = workflowRun({
  state: "stopped",
  endedAt: now,
  agents: workflowRun().agents.map((agent) =>
    agent.state === "completed"
      ? agent
      : { ...agent, state: "stopped" as const, reason: "the workflow stopped", endedAt: now },
  ),
});
const writerWorkflow = workflowRun({
  ...completedWorkflow,
  id: "wf-mg3k2l-6",
  name: "fix-findings",
  agents: [
    {
      callId: 1,
      runId: "agent-12",
      label: "fix:session-timeout",
      profile: "worker",
      state: "completed",
      queuedAt: now - 120_000,
      workspaceId: "workspace-4",
    },
  ],
  reused: 2,
  resumedFrom: "wf-mg3k2l-1",
  result: { text: "Fixed 1 finding; proposal in workspace-4.", clipped: false },
});

/** A migration whose worktree writers mostly found nothing to change, so only one proposal is left. */
const migrateWorkflow = workflowRun({
  ...completedWorkflow,
  name: "migrate-call-sites",
  agents: ["billing", "invoices", "ledger", "payroll"].map((site, index) => ({
    callId: index + 1,
    runId: `agent-${30 + index}`,
    label: `migrate:${site}`,
    profile: "worker",
    state: "completed" as const,
    queuedAt: now - 120_000,
    workspaceId: `workspace-${10 + index}`,
    ...(site !== "ledger" && { unchanged: true as const }),
  })),
  result: {
    text: "Migrated 1 of 4 call sites; the rest already used the new API.",
    clipped: false,
  },
});

/** A run past its token budget, with agents waiting for a slot and behind a paused writer. */
const budgetedWorkflow = workflowRun({
  id: "wf-mg3k2l-4",
  name: "fix-findings",
  budget: { total: 500_000, spent: 512_340, refused: 3 },
  usage: {
    ...emptyWorkflowUsage(),
    input: 8_400_000,
    output: 512_340,
    cacheRead: 3_100_000,
    totalTokens: 12_012_340,
    cost: 38.4,
    toolUses: 2_140,
    unpriced: 1,
  },
  agents: [
    ...workflowRun().agents.slice(0, 2),
    {
      callId: 3,
      runId: "agent-9",
      label: "fix:session-timeout",
      phase: "Verify",
      profile: "worker",
      state: "queued",
      queuedAt: now - 30_000,
      waiting: { kind: "writer", runId: "agent-4", name: "fix:token-refresh", paused: true },
    },
    {
      callId: 4,
      runId: "agent-10",
      label: "verify:2",
      phase: "Verify",
      profile: "reviewer",
      state: "queued",
      queuedAt: now - 20_000,
      waiting: { kind: "slot" },
    },
  ],
});

/** A script that didn't catch the budget error: its saved copy, one refused queued call, one warning. */
const budgetWarning = {
  at: now - 20_000,
  level: "warning" as const,
  message:
    "The token budget of 500000 output tokens is spent (512340 so far), so agent() calls that haven't started throw a budget error, which yields null inside parallel() and pipeline(); agents already running finish.",
};
const budgetFailedWorkflow = workflowRun({
  id: "wf-mg3k2l-7",
  name: "fix-findings",
  state: "failed",
  endedAt: now,
  scriptPath: "/home/me/.pi/agent/subagents/workflow-runs/wf-mg3k2l-7/script.js",
  journalPath: "/home/me/.pi/agent/subagents/workflow-runs/wf-mg3k2l-7/journal.jsonl",
  budget: { total: 500_000, spent: 512_340, refused: 1 },
  usage: { ...completedWorkflow.usage, output: 512_340, totalTokens: 9_812_340, cost: 31.2 },
  agents: workflowRun().agents.map(({ waiting: _waiting, ...agent }) =>
    agent.state === "queued"
      ? { ...agent, state: "skipped" as const, reason: WORKFLOW_BUDGET_REASON, endedAt: now }
      : { ...agent, state: "completed" as const, endedAt: now },
  ),
  logs: [...workflowRun().logs, budgetWarning],
  warnings: [budgetWarning],
  failure: {
    name: WORKFLOW_BUDGET_ERROR,
    message:
      "The workflow's token budget is spent: 512340 of 500000 output tokens. agent() can't start more agents; check budget.remaining() before calling it.",
    stack: "at <anonymous> (line 9:16)",
  },
});

/**
 * A fan-out stuck at its barrier: one long-running agent, a question, a paused writer, a writer
 * held for claim containment and a paused agent its backend can't resume.
 */
const stuckAgent = (index: number, patch: Partial<WorkflowAgentView> = {}): WorkflowAgentView =>
  workflowAgentView({
    callId: index,
    runId: `agent-s${index}`,
    label: `migrate:module-${index}`,
    phase: "Migrate",
    profile: "worker",
    state: "completed",
    queuedAt: now - 40 * 60_000,
    startedAt: now - 39 * 60_000,
    endedAt: now - 30 * 60_000,
    ...patch,
  });
const stuckWorkflow = workflowRun({
  id: "wf-mg3k2l-5",
  name: "migrate-modules",
  phases: [{ title: "Migrate" }, { title: "Verify" }],
  currentPhase: "Migrate",
  startedAt: now - 40 * 60_000,
  agents: [
    ...Array.from({ length: 194 }, (_, index) => stuckAgent(index + 1)),
    stuckAgent(195, { state: "running", endedAt: undefined, startedAt: now - 20 * 60_000 }),
    stuckAgent(196, { state: "running", endedAt: undefined, startedAt: now - 15 * 60_000 }),
    stuckAgent(197, { state: "running", endedAt: undefined, startedAt: now - 38 * 60_000 }),
    stuckAgent(198, { state: "running", endedAt: undefined, startedAt: now - 12 * 60_000 }),
    stuckAgent(199, { state: "failed", reason: "Tests failed in src/billing/invoice.ts" }),
    stuckAgent(200, {
      state: "queued",
      startedAt: undefined,
      endedAt: undefined,
      waiting: { kind: "writer", runId: "agent-s198", name: "migrate:module-198", paused: true },
    }),
  ],
  logs: [{ at: now - 30 * 60_000, level: "info", message: `${"x".repeat(1_800)} long log line` }],
  usage: {
    ...emptyWorkflowUsage(),
    input: 21_400_000,
    output: 610_000,
    cacheRead: 9_800_000,
    totalTokens: 31_810_000,
    cost: 41.7,
    toolUses: 3_880,
  },
});
const stuckAttention: ReadonlyArray<WorkflowAgentAttention> = [
  {
    kind: "question",
    runId: "agent-s197",
    message: "The billing module has two invoice formats. Should I migrate both or only v2?",
    writer: true,
  },
  { kind: "containment", runId: "agent-s195", writer: true },
  { kind: "paused", runId: "agent-s196", writer: false, canResume: false },
  { kind: "paused", runId: "agent-s198", writer: true, canResume: true },
];

const workflowRuns: ReadonlyArray<WorkflowRunView> = [
  completedWorkflow,
  failedWorkflow,
  runtimeFailedWorkflow,
];

const runDirectory = "/home/me/.pi/agent/subagents/workflow-runs/wf-mg3k2l-1";

const plannedReviewScript = `export const meta = {
  name: "review-changes",
  description: "Review the diff by dimension, then verify each finding",
  phases: [
    { title: "Review", agents: ["correctness", "security", { label: "performance", profile: "reviewer" }] },
    { title: "Verify", agents: ["verifier"] },
  ],
};
const found = await parallel(["correctness", "security", "performance"].map((area) => () =>
  agent(\`Review the uncommitted diff for \${area} bugs.\`, { label: area, phase: "Review", profile: "reviewer" })));
phase("Verify");
return await agent(\`Verify: \${JSON.stringify(found)}\`);`;

const targetedScript = `export const meta = {
  name: "audit-module",
  description: "Audit one module for a concern",
  args: {
    type: "object",
    properties: {
      module: { type: "string" },
      concern: { enum: ["security", "performance"] },
      depth: { type: "integer" },
    },
    required: ["module", "concern"],
  },
};
return await agent(\`Audit \${args.module} for \${args.concern} issues.\`);`;

/** A started run as the service returns it: planned agents from meta, and its saved script. */
const startedRun = (script: WorkflowScript) =>
  workflowRun({
    agents: [],
    logs: [],
    phases: script.meta.phases ?? [],
    planned: (script.meta.phases ?? [])
      .flatMap((phase) => workflowPlannedAgents(phase))
      .map((agent, index) => ({ ...agent, runId: `agent-${20 + index}` })),
    scriptPath: `${runDirectory}/script.js`,
  });

/** A run an earlier Pi process of the session left interrupted, as its files describe it. */
const recordedWorkflow: WorkflowRecordedRun = {
  id: "wf-k3c9-2",
  name: "fix-findings",
  source: { kind: "inline" },
  scriptPath: "/home/user/.pi/agent/subagents/workflow-runs/wf-k3c9-2/script.js",
  state: "interrupted",
  startedAt: 1_767_225_600_000,
  finished: 3,
  journalPath: "/home/user/.pi/agent/subagents/workflow-runs/wf-k3c9-2/journal.jsonl",
};

/** A run of the session that another live Pi process still runs. */
const recordedElsewhere: WorkflowRecordedRun = {
  id: "wf-k3c9-3",
  name: "fix-findings",
  source: { kind: "inline" },
  scriptPath: "/home/user/.pi/agent/subagents/workflow-runs/wf-k3c9-3/script.js",
  state: "running",
  runningIn: 48_213,
  startedAt: now - 12 * 60_000,
  finished: 1,
  journalPath: "/home/user/.pi/agent/subagents/workflow-runs/wf-k3c9-3/journal.jsonl",
};

const galleryWorkflowStatus: WorkflowServiceContract["status"] = (runId) => {
  if (runId === stuckWorkflow.id)
    return Effect.succeed<WorkflowStatus>({
      kind: "view",
      run: stuckWorkflow,
      attention: stuckAttention,
    });
  const found = [workflowRun(), budgetedWorkflow, budgetFailedWorkflow, ...workflowRuns].find(
    (run) => run.id === runId,
  );
  if (found) return Effect.succeed<WorkflowStatus>({ kind: "view", run: found, attention: [] });
  const recorded = [recordedWorkflow, recordedElsewhere].find((run) => run.id === runId);
  if (recorded) return Effect.succeed<WorkflowStatus>({ kind: "recorded", run: recorded });
  return Effect.fail(
    new WorkflowNotFoundError({ message: `No workflow run ${runId} in this session.` }),
  );
};

/** A running run whose previous status call, 14 seconds earlier, saw the same counts. */
const repeatedWorkflow = workflowRun({ id: "wf-mg3k2l-9" });

/** A fixed workflow service: the tool's real execute path, deterministic views. */
const galleryWorkflows: WorkflowServiceContract = {
  start: (request) =>
    request.source.kind === "inline"
      ? parseWorkflowScript(request.source.script).pipe(
          Effect.tap((script) => requireWorkflowArgs(script.args, script.meta.name, request.args)),
          Effect.map((script) => ({
            ...startedRun(script),
            ...(request.budget !== undefined && {
              budget: { total: request.budget, spent: 0, refused: 0 },
            }),
          })),
        )
      : Effect.succeed(workflowRun({ agents: [], logs: [] })),
  stop: () => Effect.succeed({ ...stoppedWorkflow, stoppedBy: "tool" }),
  status: galleryWorkflowStatus,
  toolStatus: (runId) =>
    runId === repeatedWorkflow.id
      ? Effect.succeed<WorkflowToolStatus>({
          kind: "unchanged",
          run: repeatedWorkflow,
          sinceMs: 14_000,
        })
      : galleryWorkflowStatus(runId),
  list: Effect.succeed(workflowRuns),
  skip: () => Effect.void,
};

const galleryWorkflowLocations = {
  project: "/project/.pi/workflows",
  projectTrusted: true,
  user: "/home/user/.pi/agent/workflows",
};

const workflowRuntime: WorkflowToolRuntime = {
  environment: { cwd: "/project", projectTrusted: true },
  savedWorkflowLocations: galleryWorkflowLocations,
  run: (effect) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(WorkflowService, galleryWorkflows),
        Effect.provideService(WorkflowStore, {
          load: () => Effect.die(new Error("unused")),
          loadPath: () => Effect.die(new Error("unused")),
          createRunFiles: () => Effect.die(new Error("unused")),
          appendRunJournal: () => Effect.die(new Error("unused")),
          touchRunFiles: () => Effect.void,
          writeRunRecord: () => Effect.die(new Error("unused")),
          readRunRecord: () => Effect.die(new Error("unused")),
          hasRunFiles: () => Effect.succeed(false),
          listRunRecords: () => Effect.succeed([]),
          writeRunResult: () => Effect.die(new Error("unused")),
          readRunResult: () => Effect.undefined,
          readRunJournal: () => Effect.succeed([]),
          locations: Effect.succeed(galleryWorkflowLocations),
          list: Effect.succeed({
            workflows: [
              {
                name: "review-changes",
                scope: "project" as const,
                path: "/project/.pi/workflows/review-changes.js",
                meta: {
                  name: "review-changes",
                  description: "Review the diff by dimension, then verify each finding",
                  whenToUse: "Before committing a change that touches more than one module",
                  phases: [{ title: "Review" }, { title: "Verify" }],
                  args: {
                    type: "object",
                    properties: { scope: { type: "string" }, strict: { type: "boolean" } },
                    required: ["scope"],
                  },
                },
              },
            ],
            diagnostics: [
              {
                path: "/project/.pi/workflows/draft.js",
                message: "Invalid meta: missing description",
              },
            ],
            truncated: false,
            locations: galleryWorkflowLocations,
          }),
        }),
        Effect.provideService(SubagentProfileService, fallbackProfileService),
        Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
      ),
    ),
};

const workflowScenarios = Effect.gen(function* () {
  const [tool] = captureRegistrations((pi) => registerWorkflowTool(pi, workflowRuntime)).tools;
  const execute = (title: string, args: Partial<WorkflowToolArgs>): Effect.Effect<ToolScenario> =>
    Effect.promise(() => tool!.execute("call", args, undefined, undefined, context)).pipe(
      Effect.map((result) => ({
        tool: "subagent_workflow",
        title,
        args,
        result,
        ...(result.isError === true && { isError: true }),
      })),
    );
  return [
    yield* execute("start an inline script", {
      action: "start",
      script: reviewScript,
      args: { scope: "src/auth" },
    }),
    yield* execute("start a script that declares its agents", {
      action: "start",
      script: plannedReviewScript,
      args: { scope: "src/auth" },
    }),
    yield* execute("script without meta is rejected", { action: "start", script: "return 1;" }),
    yield* execute("start with args that don't match the script's meta.args", {
      action: "start",
      script: targetedScript,
      args: { module: "src/auth", concern: "style" },
    }),
    yield* execute("script with a syntax error is rejected", {
      action: "start",
      script: 'export const meta = { name: "broken", description: "d" };\nconst x: number = 1;',
    }),
    yield* execute("status while agents run", { action: "status", runId: workflowRun().id }),
    yield* execute("status past its token budget, agents waiting", {
      action: "status",
      runId: budgetedWorkflow.id,
    }),
    yield* execute("status repeated within a minute while nothing changed", {
      action: "status",
      runId: repeatedWorkflow.id,
    }),
    yield* execute("status of a stuck fan-out that needs the user", {
      action: "status",
      runId: stuckWorkflow.id,
    }),
    yield* execute("start with a token budget", {
      action: "start",
      script: reviewScript,
      budget: 500_000,
    }),
    yield* execute("status after completion", { action: "status", runId: completedWorkflow.id }),
    yield* execute("status after a script error", {
      action: "status",
      runId: failedWorkflow.id,
    }),
    yield* execute("status after a runtime dependency failure", {
      action: "status",
      runId: runtimeFailedWorkflow.id,
    }),
    yield* execute("status after its token budget was spent and the script didn't catch it", {
      action: "status",
      runId: budgetFailedWorkflow.id,
    }),
    yield* execute("status of a run from before a Pi restart", {
      action: "status",
      runId: recordedWorkflow.id,
    }),
    yield* execute("status of a run another Pi process runs", {
      action: "status",
      runId: recordedElsewhere.id,
    }),
    yield* execute("unknown run", { action: "status", runId: "wf-old-3" }),
    yield* execute("stop", { action: "stop", runId: "wf-mg3k2l-1" }),
    yield* execute("list saved workflows and runs", { action: "list" }),
  ];
});

// ─── Notification messages ───────────────────────────────────────────────────

type SentMessage = Pick<GalleryMessage, "customType" | "content" | "display" | "details">;

/** Messages exactly as the root notifier sends them. */
const notified = (
  title: string,
  notification: SubagentNotification | SubagentWorkflowNotification,
) => {
  const messages: GalleryMessage[] = [];
  makeHostNotifier(
    extensionApiFixture({
      sendMessage: (message: SentMessage) => {
        messages.push({ role: "custom", timestamp: 0, ...message });
      },
    }),
  )(notification);
  return messages.map((message): GalleryMessageScenario => ({ title, message }));
};

const completion = (
  run: SubagentRunView,
  overrides: Partial<SubagentCompletionNotification> = {},
): SubagentCompletionNotification => ({
  id: run.id,
  name: run.name,
  generation: 1,
  outcome: run.state === "failed" ? "failed" : "completed",
  finalText: run.finalText,
  error: run.error,
  profile: run.profile,
  ...overrides,
});

const completedReports = notified("one worker reports", {
  type: "completed",
  runs: [completion(docsSweep)],
});
const messageScenarios: ReadonlyArray<GalleryMessageScenario> = [
  ...completedReports,
  ...notified("one worker fails with a retry option", {
    type: "completed",
    runs: [completion(migrationReview, { retryAvailable: true, remainingCandidateCount: 1 })],
  }),
  ...notified("native worker reports", {
    type: "completed",
    runs: [completion(apiAudit)],
  }),
  ...notified("three workers finish", {
    type: "completed",
    runs: [
      completion(docsSweep, { warning: "README.md is generated; edit docs/readme.hbs instead" }),
      completion({ ...authReview, finalText: "The refresh flow is safe." }),
      completion(migrationReview),
    ],
  }),
  ...notified("workflow completed", workflowNotification(completedWorkflow)!),
  ...notified(
    "workflow completed with a results journal",
    workflowNotification({
      ...completedWorkflow,
      scriptPath: `${runDirectory}/script.js`,
      journalPath: `${runDirectory}/journal.jsonl`,
      planned: [{ runId: "agent-23", phase: "Verify", label: "verifier" }],
    })!,
  ),
  ...notified(
    "workflow script failed with a saved script",
    workflowNotification({
      ...failedWorkflow,
      scriptPath: `${runDirectory}/script.js`,
      journalPath: `${runDirectory}/journal.jsonl`,
    })!,
  ),
  ...notified("resumed workflow with a worktree proposal", workflowNotification(writerWorkflow)!),
  ...notified(
    "workflow whose worktree writers mostly made no changes",
    workflowNotification(migrateWorkflow)!,
  ),
  ...notified(
    "workflow completed over its token budget",
    workflowNotification({
      ...completedWorkflow,
      budget: { total: 500_000, spent: 512_340, refused: 3 },
      usage: { ...completedWorkflow.usage, output: 512_340, totalTokens: 9_812_340, cost: 31.2 },
    })!,
  ),
  ...notified("workflow script failed", workflowNotification(failedWorkflow)!),
  ...notified("workflow runtime failed", workflowNotification(runtimeFailedWorkflow)!),
  ...notified(
    "workflow failed when its token budget was spent",
    workflowNotification(budgetFailedWorkflow)!,
  ),
  ...notified("workflow stopped", workflowNotification(stoppedWorkflow)!),
  ...notified(
    "workflow stopped by the user",
    workflowNotification({ ...stoppedWorkflow, stoppedBy: "user" })!,
  ),
  ...notified(
    "workflow interrupted while it was stopping",
    interruptedWorkflowNotification({
      runId: "wf-k3c9-3",
      name: "review-changes",
      finished: 2,
      workspaces: [],
      stopped: true,
      origin: { source: { kind: "inline" } },
    }),
  ),
  ...notified(
    "workflow interrupted by a reload",
    interruptedWorkflowNotification({
      runId: "wf-k3c9-2",
      name: "fix-findings",
      finished: 3,
      workspaces: ["ws-7f2a"],
      origin: { source: { kind: "inline" } },
    }),
  ),
  ...notified(
    "workflow interrupted before a Pi restart",
    interruptedWorkflowNotification({
      runId: "wf-k3c9-2",
      name: "fix-findings",
      finished: 3,
      workspaces: ["ws-7f2a"],
      origin: {
        source: { kind: "inline" },
        scriptPath: recordedWorkflow.scriptPath,
      },
      restarted: true,
    }),
  ),
  ...notified(
    "workflow whose report Pi never accepted before a restart",
    interruptedWorkflowNotification({
      runId: "wf-k3c9-4",
      name: "review-changes",
      finished: 4,
      workspaces: [],
      ended: "completed",
      origin: {
        source: { kind: "inline" },
        scriptPath: recordedWorkflow.scriptPath,
      },
      restarted: true,
    }),
  ),
  ...notified("worker needs a reply", {
    type: "question",
    id: dbMigration.id,
    name: dbMigration.name,
    requestId: "q-1",
    message: dbMigration.question?.message ?? "",
    generation: 1,
  }),
  ...completedReports.map(({ message }) => ({
    title: "forwarded to a nested worker",
    message: { ...message, customType: "pi-subagents-proxy-notification", details: undefined },
  })),
  {
    title: "peer notice",
    message: {
      role: "custom",
      customType: "pi-subagents-peer-notice",
      display: true,
      timestamp: 0,
      content: [
        "Your current ownership summary: read-only. A parent reply is authoritative for any complete changed claim set.",
        "",
        "You share this working directory with 1 other active subagent:",
        "",
        "- db-migration (agent-6): writer claims db/0007.sql, src/db/schema.ts; running; task: Implement the 0007 migration",
        "",
        "The parent owns coordination and all claim grants. Writers may run concurrently only with disjoint exact-file claims. Never edit a peer's claimed file; contact the parent and wait before work that could overlap another task.",
      ].join("\n"),
    },
  },
];

// ─── Activity ────────────────────────────────────────────────────────────────

/** A workflow member's subagent run, as the root projection shows it. */
const member = (agent: WorkflowAgentView, overrides: Partial<SubagentRunView> = {}) =>
  view({
    id: agent.runId,
    name: agent.label,
    task: `Verify the finding: ${agent.label}`,
    profile: "reviewer",
    workflow: { workflowId: "wf-mg3k2l-1", name: "review-changes", phase: agent.phase },
    ...timing(3),
    ...overrides,
  });

const [correctness, security] = workflowRun().agents;
const correctnessRun = member(correctness!, {
  state: "completed",
  finalText:
    "Two findings:\n\n- src/auth/session.ts:118 swallows a refresh timeout\n- src/auth/token.ts:40 logs the raw token",
  sessionEvents: [
    {
      type: "tool",
      toolCallId: "t1",
      toolName: "read",
      target: "src/auth/session.ts",
      state: "completed",
      startedAt: now - 170_000,
      endedAt: now - 169_000,
    },
    {
      type: "tool",
      toolCallId: "t2",
      toolName: "grep",
      target: "refreshToken",
      state: "completed",
      startedAt: now - 120_000,
      endedAt: now - 119_000,
    },
  ],
  usage: usage(84_200, 0.61),
  toolUses: 14,
  ...timing(3, 1),
});
const securityRun = member(security!, {
  progress: "Reading src/auth/token.ts",
  currentTool: "read",
});
const queuedVerifier: WorkflowAgentView = {
  callId: 4,
  runId: "agent-10",
  label: "verify:2",
  phase: "Verify",
  profile: "reviewer",
  state: "queued",
  queuedAt: now - 20_000,
  waiting: { kind: "slot" },
};
const couldNotStart: WorkflowAgentView = {
  callId: 3,
  runId: "agent-9",
  label: "verify:1",
  phase: "Verify",
  profile: "reviewer",
  state: "failed",
  queuedAt: now - 30_000,
  endedAt: now - 25_000,
  reason:
    "couldn't start: No eligible route for profile reviewer: every candidate is over its rate limit",
};
const skippedWhileQueued: WorkflowAgentView = {
  ...couldNotStart,
  state: "skipped",
  reason: "skipped by the user",
};
const failedMemberAgent: WorkflowAgentView = {
  ...security!,
  state: "failed",
  endedAt: now - 10_000,
  reason: "Error: 429 Too Many Requests: rate limit exceeded",
};
const failedMemberRun = member(failedMemberAgent, {
  state: "failed",
  error: "Error: 429 Too Many Requests: rate limit exceeded\n    at Client.request",
  ...timing(3, 0.2),
});

/** A live workflow whose Verify phase has the given agents beside the two reviewers. */
const reviewWorkflow = (
  agents: ReadonlyArray<WorkflowAgentView>,
  patch: Partial<WorkflowRunView> = {},
): WorkflowRunView =>
  workflowRun({
    currentPhase: "Verify",
    agents: [correctness!, security!, ...agents],
    ...patch,
  });

const workParts = (phase: ActivityPhase): string =>
  phase.work
    ? `${phase.work.finished}/${phase.work.items} finished, ${phase.work.stopped} stopped, ${phase.work.failed ?? 0} failed, ${phase.work.skipped ?? 0} skipped`
    : "no work count";

/** One published row per line, nested under its workflow and phase as Activity places it. */
const activityRowLine = (item: ActivityItem): string => {
  const status = item.skipped ? `${item.status} (skipped)` : item.status;
  const head = [status, item.kind, item.title, item.phase, item.profile, item.summary]
    .filter(Boolean)
    .join(" · ");
  const actions = item.actions?.length
    ? `  [${item.actions.map((action) => action.label).join(", ")}]`
    : "";
  const phases = (item.phases ?? []).map(
    (phase) => `    phase ${phase.title}: ${workParts(phase)}`,
  );
  return [`${item.parent ? "  " : ""}${head}${actions}`, ...phases].join("\n");
};

interface ActivityScenario {
  readonly title: string;
  readonly runs: ReadonlyArray<SubagentRunView>;
  readonly workflows: ReadonlyArray<WorkflowRunView>;
  /** Items whose detail pane the scenario shows. */
  readonly details: ReadonlyArray<string>;
}

/** Calls the token budget refused while they were queued. */
const budgetRefused = (index: number): WorkflowAgentView => ({
  ...couldNotStart,
  callId: 10 + index,
  runId: `agent-${40 + index}`,
  label: `verify:${index}`,
  state: "skipped",
  endedAt: now - 15_000,
  reason: WORKFLOW_BUDGET_REASON,
});

const activityScenarios: ReadonlyArray<ActivityScenario> = [
  {
    title: "a workflow being stopped by the user",
    runs: [correctnessRun, { ...securityRun, state: "stopping" }],
    workflows: [reviewWorkflow([queuedVerifier], { state: "stopping", stoppedBy: "user" })],
    details: ["workflow:wf-mg3k2l-1", securityRun.id],
  },
  {
    title: "agents the token budget refused",
    runs: [correctnessRun, securityRun],
    workflows: [
      reviewWorkflow([budgetRefused(1), budgetRefused(2)], {
        budget: { total: 200_000, spent: 212_340, refused: 2 },
      }),
    ],
    details: [budgetRefused(1).runId],
  },
  {
    title: "a call that couldn't start keeps a failed row",
    runs: [correctnessRun, securityRun],
    workflows: [reviewWorkflow([couldNotStart, queuedVerifier])],
    details: [couldNotStart.runId],
  },
  {
    title: "an agent skipped while queued keeps a skipped row",
    runs: [correctnessRun, securityRun],
    workflows: [reviewWorkflow([skippedWhileQueued, queuedVerifier])],
    details: [skippedWhileQueued.runId],
  },
  {
    title: "a planned agent skipped before it started",
    runs: [correctnessRun, securityRun],
    workflows: [
      reviewWorkflow([queuedVerifier], {
        planned: [
          { runId: "agent-11", phase: "Verify", label: "verify:3", skippedAt: now - 12_000 },
          { runId: "agent-12", phase: "Verify", label: "verify:4", profile: "reviewer" },
        ],
      }),
    ],
    details: ["agent-11", "agent-12"],
  },
  {
    title: "a member that failed in a live workflow",
    runs: [correctnessRun, failedMemberRun],
    workflows: [
      workflowRun({
        currentPhase: "Verify",
        agents: [correctness!, failedMemberAgent, queuedVerifier],
      }),
    ],
    details: [failedMemberRun.id],
  },
  {
    title: "a workflow agent's detail",
    runs: [correctnessRun, securityRun],
    workflows: [reviewWorkflow([queuedVerifier])],
    details: [correctnessRun.id, securityRun.id],
  },
  {
    title: "a workflow's detail with failures, files and a budget",
    runs: [correctnessRun, failedMemberRun],
    workflows: [
      workflowRun({
        currentPhase: "Verify",
        agents: [correctness!, failedMemberAgent, couldNotStart, queuedVerifier],
        scriptPath: `${runDirectory}/script.js`,
        journalPath: `${runDirectory}/journal.jsonl`,
        budget: { total: 500_000, spent: 212_340, refused: 0 },
        lastLog: "verifying 2 findings",
        logs: [
          { at: now - 60_000, level: "info", message: "correctness review found 2 findings" },
          {
            at: now - 25_000,
            level: "warning",
            message: `agent "verify:1" failed: ${couldNotStart.reason}`,
          },
          { at: now - 20_000, level: "info", message: "verifying 2 findings" },
        ],
      }),
    ],
    details: ["workflow:wf-mg3k2l-1"],
  },
];

const activityLines = (): ReadonlyArray<string> =>
  activityScenarios.flatMap((scenario) => {
    const projection = { revision: 1, runs: scenario.runs };
    const workflows = { runs: scenario.workflows };
    const items = subagentActivityItems(projection, undefined, workflows);
    const gallery = {
      title: scenario.title,
      providerId: "pi-subagents",
      items,
      detail: (id: string) => subagentActivityDetail(projection, id, workflows, now),
      now,
    };
    return [
      `── activity · ${scenario.title} · published rows`,
      ...items.map(activityRowLine),
      "",
      // What people see: the persistent widget, wide and beside an input dock, then the manager
      // with the workflow and each scenario item opened.
      ...activityGalleryFrames({ ...gallery, widths: [60, 80, 100], maxRows: [8] }),
      ...activityGalleryFrames({
        ...gallery,
        widths: [80],
        maxRows: [3],
        open: [...new Set([`workflow:${scenario.workflows[0]?.id ?? ""}`, ...scenario.details])],
      }),
    ];
  });

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  // Worker reports render as Markdown, which reads Pi's global theme.
  beforeAll(() => initTheme("dark", false));

  it.effect("renders subagent tools and notifications in both collapsed styles", () =>
    Effect.gen(function* () {
      const executed = [
        ...(yield* modelScenarios),
        ...(yield* startScenarios),
        ...(yield* awaitScenarios),
        ...(yield* inspectionScenarios),
        ...(yield* messagingScenarios),
        ...(yield* lifecycleScenarios),
        ...(yield* claimsScenarios),
        ...(yield* workspaceScenarios),
        ...(yield* workflowScenarios),
      ];
      const scenarios = [...executed, ...receiptScenarios, ...parentScenarios, ...resultScenarios];
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          // The shell captures the collapsed style at registration.
          const registered = captureRegistrations((pi) => {
            registerSubagentTools(pi, runtime);
            registerWorkflowTool(pi, workflowRuntime);
            registerSubagentMessageRenderers(pi);
          });
          const tools = [...registered.tools, contactParentTool(), resultTool()];
          for (const { tool, ...entry } of scenarios)
            lines.push(
              ...galleryFrames(tools.find((candidate) => candidate.name === tool)!, {
                ...entry,
                title: `${style} · ${tool} · ${entry.title}`,
              }),
            );
          for (const entry of messageScenarios)
            lines.push(
              ...galleryMessageFrames(registered.messageRenderers.get(entry.message.customType)!, {
                ...entry,
                title: `${style} · ${entry.message.customType} · ${entry.title}`,
              }),
            );
        } finally {
          restore();
        }
      }
      lines.push(...activityLines());
      yield* writeGallerySection(directory, "pi-subagents", lines);
    }),
  );
});
