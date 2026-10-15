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
import type { ActivityItem } from "pi-cosmic-ui/activity";
import { activityGalleryFrames } from "pi-cosmic-ui/activity/testing";
import { renderSubagentMessage } from "../src/application/messages.ts";
import { subagentActivityDetail, subagentActivityItems } from "../src/ui/run-activity.ts";
import {
  projectSubagentActivityPanel,
  renderProjectedSubagentActivityPanel,
} from "../src/ui/activity-panel.ts";
import { SubagentBackendRegistry } from "../src/backend/service.ts";
import {
  hostNotifier,
  type SubagentCompletionNotification,
  type SubagentNotification,
} from "../src/boundary/host-notifier.ts";
import {
  STOPPED_RUNS_MESSAGE_TYPE,
  stoppedRunsContent,
} from "../src/boundary/host-stopped-runs.ts";
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
import { awaitDetails, startDetails } from "../src/tools/details.ts";
import {
  CONTACT_PARENT_LABEL,
  contactParentCompactSummary,
  contactParentExpandedContent,
  contactParentRenderers,
} from "../src/tools/render-parent.ts";
import { executeSubagentActionEffect, type SubagentToolRuntime } from "../src/tools/execute.ts";
import { awaitExecutionFor } from "../src/tools/execute-await.ts";
import { decodeSubagentOutcomeDetails, marksSubagentToolError } from "../src/tools/outcome.ts";
import { subagentToolAction, type SubagentToolInput } from "../src/tools/schema.ts";
import { registerSubagentTools } from "../src/tools/subagent.ts";
import type { WorkspaceRecord } from "../src/workspace/model.ts";
import { extensionApiFixture, plainTheme } from "pi-cosmic-core/testing";
import { containedWriter, view } from "./fixtures/run-view.ts";
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

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});

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
      const details = decodeSubagentOutcomeDetails(subagentToolAction(input), result);
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
        agents: [{ profile: "worker", name: "script-edit", task: "Implement the change" }],
      },
    },
    { scripted: true },
  );
  const blockedDescendant = yield* scenario(
    "script-origin descendant cannot delegate writer work",
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
  const cancellation = awaitExecutionFor(awaitInput.args.runIds, "all_finished");
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
  candidates: [candidate({ model: "anthropic/claude-opus-4-7" }), candidate()].map((entry) =>
    Object.assign({}, entry, { openaiFastMode: false, closeOnReport: true }),
  ),
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

const awaited = (
  title: string,
  runs: Parameters<typeof awaitDetails>[0]["runs"],
  extra: Partial<Parameters<typeof awaitDetails>[0]> = {},
): ToolScenario => ({
  tool: "subagent_await",
  title,
  args: { runIds: runs.map((run) => run.id), until: "all_finished" },
  result: {
    content: [{ type: "text", text: "Agent-facing await report" }],
    details: awaitDetails({ runs, awaitUntil: "all_finished", ...extra }),
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
  {
    tool: "subagent_start",
    title: "expanded writer task and exact file claims",
    args: {
      agents: [
        {
          name: "refresh-fix",
          profile: "worker",
          task: [
            "Fix the session refresh timeout handling.",
            "Preserve the caller's cancellation and keep late responses from updating a newer session.",
            "Add a regression for a refresh response arriving after a session switch.",
            "Only change the files claimed below; report any other required changes to the parent.",
          ].join("\n"),
          writes: ["src/auth/session.ts", "tests/auth/session.test.ts"],
        },
      ],
    },
    phase: "pending",
  },
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
      details: startDetails({
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
  overrides: Partial<GalleryScenario>,
): ToolScenario => ({ tool: "contact_parent", title, args: { kind, message }, ...overrides });

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

type SentMessage = Pick<GalleryMessage, "customType" | "content" | "display" | "details">;

const notified = (title: string, notification: SubagentNotification) => {
  const messages: GalleryMessage[] = [];
  hostNotifier(
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
  ...notified("worker needs a reply", {
    type: "question",
    id: dbMigration.id,
    name: dbMigration.name,
    requestId: "q-1",
    message: dbMigration.question?.message ?? "",
    generation: 1,
  }),
  {
    title: "moving in the session tree stops workers",
    message: {
      role: "custom",
      customType: STOPPED_RUNS_MESSAGE_TYPE,
      display: true,
      timestamp: 0,
      content: stoppedRunsContent([authReview, dbMigration], "tree"),
      details: { version: 1, kind: "stopped", total: 2 },
    },
  },
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

const activityRowLine = (item: ActivityItem): string => {
  const head = [item.status, item.kind, item.title, item.profile, item.summary]
    .filter(Boolean)
    .join(" · ");
  const actions = item.actions?.length
    ? `  [${item.actions.map((action) => action.label).join(", ")}]`
    : "";
  return `${item.parent ? "  " : ""}${head}${actions}`;
};

interface ActivityScenario {
  readonly title: string;
  readonly runs: ReadonlyArray<SubagentRunView>;
  readonly details: ReadonlyArray<string>;
}

const worktreeProposal = view({
  id: "agent-10",
  name: "refresh-fix",
  profile: "worker",
  writeIntent: "writer",
  writerWorkspaceMode: "worktree",
  workspaceId: "ws-1",
  state: "completed",
  finalText: "Fixed the refresh timeout; changes are ready for parent review.",
  usage: usage(105_000, 0.82),
  ...timing(5, 1),
});

const activityScenarios: ReadonlyArray<ActivityScenario> = [
  {
    title: "active agents with descendants and completed reports",
    runs: [authReview, docsSweep, apiAudit, schemaCheck],
    details: [authReview.id, docsSweep.id, schemaCheck.id],
  },
  {
    title: "a writer question and file-claim recovery",
    runs: [dbMigration, apiWriter],
    details: [dbMigration.id, apiWriter.id],
  },
  {
    title: "failed and completed native agents",
    runs: [migrationReview, apiAudit],
    details: [migrationReview.id, apiAudit.id],
  },
  {
    title: "a completed worktree writer proposal",
    runs: [worktreeProposal],
    details: [worktreeProposal.id],
  },
  {
    title: "a running child's messages and tool output",
    runs: [
      view({
        id: "agent-30",
        name: "token-parser",
        state: "running",
        usage: { ...usage(84_000, 0.21), contextPercent: 83 },
        ...timing(4),
        sessionEvents: [
          {
            type: "assistant",
            text: "Checking the **token parser** before touching the lexer.",
            createdAt: now - 200_000,
          },
          {
            type: "tool",
            toolCallId: "t1",
            toolName: "bash",
            target: "pnpm test token",
            state: "failed",
            startedAt: now - 150_000,
            endedAt: now - 140_000,
            outputPreview: "FAIL tests/token.test.ts > parses escapes\nexpected 2 but got 3",
          },
          {
            type: "assistant",
            text: "The escape handling double-counts backslashes; fixing that next.",
            createdAt: now - 100_000,
          },
        ],
      }),
    ],
    details: ["agent-30"],
  },
  {
    title: "a subtree being stopped",
    runs: [
      { ...authReview, state: "stopping" },
      { ...schemaCheck, state: "stopping" },
    ],
    details: [authReview.id, schemaCheck.id],
  },
];

const activityLines = (): ReadonlyArray<string> =>
  activityScenarios.flatMap((activity) => {
    const projection = { revision: 1, runs: activity.runs };
    const items = subagentActivityItems(projection);
    const gallery = {
      title: activity.title,
      providerId: "pi-subagents",
      items,
      detail: (id: string) => subagentActivityDetail(projection, id),
      now,
    };
    return [`── activity · ${activity.title} · published rows`].concat(
      items.map(activityRowLine),
      [""],
      activityGalleryFrames({ ...gallery, widths: [60, 80, 100], maxRows: [8] }),
      activityGalleryFrames({ ...gallery, widths: [80], maxRows: [3], open: activity.details }),
    );
  });

const minutesAgo = (minutes: number) => now - minutes * 60_000;
const stalledRuns: ReadonlyArray<SubagentRunView> = [
  view({
    id: "agent-20",
    name: "flaky-suite",
    state: "running",
    startedAt: minutesAgo(9),
    lastActivityAt: minutesAgo(7),
    sessionEvents: [
      {
        type: "tool",
        toolCallId: "t1",
        toolName: "bash",
        state: "running",
        startedAt: minutesAgo(7),
      },
    ],
  }),
  view({
    id: "agent-21",
    name: "quiet-review",
    state: "running",
    startedAt: minutesAgo(6),
    lastActivityAt: minutesAgo(3),
    sessionEvents: [],
  }),
  view({
    id: "agent-22",
    name: "edit-retry",
    state: "running",
    startedAt: minutesAgo(2),
    lastActivityAt: minutesAgo(0),
    sessionEvents: ["t1", "t2", "t3"].map((toolCallId, index) => ({
      type: "tool" as const,
      toolCallId,
      toolName: "edit",
      state: "failed" as const,
      startedAt: minutesAgo(1) + index,
      endedAt: minutesAgo(1) + index + 1,
    })),
  }),
];

const widgetLines = (): ReadonlyArray<string> => {
  const panel = projectSubagentActivityPanel({ revision: 1, runs: stalledRuns });
  return ["── widget · stalled children (tool open, silent, failing tools)"].concat(
    [60, 100].flatMap((width) =>
      [`width ${width}`].concat(
        renderProjectedSubagentActivityPanel(panel, width, plainTheme, now),
        [""],
      ),
    ),
  );
};

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
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
      ];
      const scenarios = [...executed, ...receiptScenarios, ...parentScenarios];
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const registered = captureRegistrations((pi) => {
            registerSubagentTools(pi, runtime);
          });
          const tools = [...registered.tools, contactParentTool()];
          for (const { tool, ...entry } of scenarios)
            lines.push(
              ...galleryFrames(tools.find((definition) => definition.name === tool)!, {
                ...entry,
                title: `${style} · ${tool} · ${entry.title}`,
              }),
            );
          for (const entry of messageScenarios)
            lines.push(
              ...galleryMessageFrames(renderSubagentMessage, {
                ...entry,
                title: `${style} · ${entry.message.customType} · ${entry.title}`,
              }),
            );
        } finally {
          restore();
        }
      }
      lines.push(...activityLines(), ...widgetLines());
      yield* writeGallerySection(directory, "pi-subagents", lines);
    }),
  );
});
