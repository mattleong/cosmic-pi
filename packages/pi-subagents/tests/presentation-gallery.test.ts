import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  galleryMessageFrames,
  galleryTranscriptFrames,
  withPresentationSettings,
  writeGallerySection,
  type GalleryMessageScenario,
  type GalleryTranscriptEntry,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { withCodePreviewShell } from "pi-code-previews";
import { synchronousNow } from "pi-cosmic-core";
import {
  defineTool,
  initTheme,
  type AgentToolUpdateCallback,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Type } from "typebox";
import type { ActivityItem } from "pi-cosmic-ui/activity";
import { activityGalleryFrames } from "pi-cosmic-ui/activity/testing";
import { renderAgentMessageEntry, renderSubagentMessage } from "../src/application/messages.ts";
import { AGENT_MESSAGE_TYPE, agentMessageDetails } from "../src/boundary/host-agent-messages.ts";
import {
  agentMessageContent,
  MAIN_AGENT_SENDER,
  runSender,
  type AgentListEntry,
  type AgentReadout,
  type AgentSendResult,
} from "../src/run/agent-messaging.ts";
import { executeAgentActionEffect } from "../src/tools/execute-agents.ts";
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
  stoppedRunsDetails,
} from "../src/boundary/host-stopped-runs.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  SubagentProfileService,
  type SubagentProfileServiceContract,
} from "../src/profiles/service.ts";
import {
  agentMessageRefusal,
  failureFields,
  invalidRequest,
  InvalidSubagentRequestError,
  withCause,
  withGuidance,
  withGuidanceClause,
  SubagentNotFoundError,
  SubagentProcessError,
} from "../src/run/errors.ts";
import type { StartSubagentRequest, SubagentRunView } from "../src/run/model.ts";
import { scriptedWriterAdmissionError } from "../src/run/launch-policy.ts";
import { SubagentService } from "../src/run/service.ts";
import { mapWorkspaceError } from "../src/run/workspace-binding.ts";
import { WorkspaceError } from "../src/workspace/model.ts";
import { awaitDetails, compactToolDetails, startDetails } from "../src/tools/details.ts";
import {
  CONTACT_PARENT_LABEL,
  contactParentCompactSummary,
  contactParentExpandedContent,
  contactParentRenderers,
} from "../src/tools/render-parent.ts";
import { executeSubagentActionEffect, type SubagentToolRuntime } from "../src/tools/execute.ts";
import { awaitExecutionFor } from "../src/tools/execute-await.ts";
import { decodeSubagentOutcomeDetails, hasSubagentToolFailure } from "../src/tools/outcome.ts";
import { toolFailureDetails } from "../src/tools/failure-details.ts";
import {
  SUBAGENT_TOOL_SCHEMAS,
  subagentToolAction,
  type AgentToolInput,
  type SubagentToolInput,
} from "../src/tools/schema.ts";
import { registerSubagentTools } from "../src/tools/subagent.ts";
import { revisionReviewText } from "../src/run/workspace-review.ts";
import type { WorkspaceRecord } from "../src/workspace/model.ts";
import { extensionApiFixture, plainTheme } from "pi-cosmic-core/testing";
import { piArgumentRejection } from "pi-cosmic-core/testing/sdk";
import { view } from "./fixtures/run-view.ts";
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
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";

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
  model: "claude-bridge/claude-sonnet-5-5",
  effort: "medium",
  state: "completed",
  reportGeneration: 1,
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
  parentRunId: "root",
  nextCandidate: { model: "claude-bridge/claude-opus-5-5", effort: "high" },
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
  state: "waiting_for_parent",
  question: {
    requestId: "q-1",
    message: "src/db/seed.ts also needs the new column. Should I leave it for a follow-up?",
  },
  ...timing(5),
});
const apiWriter = view({
  id: "agent-9",
  name: "api-writer",
  profile: "worker",
  writeIntent: "writer",
  state: "stopped",
});

const fleet = new Map(
  Arr.map(
    [authReview, docsSweep, apiAudit, schemaCheck, migrationReview, dbMigration, apiWriter],
    (run) => [run.id, run],
  ),
);
const lookup = (id: string): Effect.Effect<SubagentRunView, SubagentNotFoundError> => {
  const run = fleet.get(id);
  return run
    ? Effect.succeed(run)
    : Effect.fail(SubagentNotFoundError.make({ id, message: `Subagent run not found: ${id}` }));
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

/** A rejected call's result as Pi stores it: the error's text, with the details the host adds. */
const rejectedResult = (error: { readonly message: string }) => ({
  content: [{ type: "text" as const, text: error.message }],
  details: toolFailureDetails(error) ?? {},
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
      return { result, isError: details !== undefined && hasSubagentToolFailure(details) };
    }),
    Effect.catch((error) => Effect.succeed({ result: rejectedResult(error), isError: true })),
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
    model: request.model,
    effort: request.effort,
    context: request.context,
    writeIntent: request.writeIntent,
    openaiFastMode: request.openaiFastMode,
    selection: request.selection ?? view().selection,
    ...(request.modelOverride && { modelOverride: request.modelOverride }),
    ...(request.agent && { agent: request.agent }),
    ...timing(0),
  });

const startInput: SubagentToolInput<"agent_start"> = {
  tool: "agent_start",
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
      tool: "agent_start",
      args: {
        agents: [{ profile: "worker", name: "script-edit", task: "Implement the change" }],
      },
    },
    { scripted: true },
  );
  const blockedDescendant = yield* scenario(
    "script-origin descendant cannot delegate writer work",
    {
      tool: "agent_start",
      args: {
        agents: [{ profile: "worker", name: "delegated-edit", task: "Implement the change" }],
      },
    },
    { service: { startSessionOwned: () => Effect.fail(scriptedWriterAdmissionError()) } },
  );
  const modelOverride = yield* scenario(
    "one launch on a model override, one override unavailable",
    {
      tool: "agent_start",
      args: {
        agents: [
          {
            name: "auth-review",
            profile: "reviewer",
            task: "Review the session refresh flow",
            model: { model: "openai-codex/gpt-5.6-sol", effort: "xhigh" },
          },
          {
            name: "docs-sweep",
            profile: "scout",
            task: "Find stale refreshToken references",
            model: { model: "openai/retired-model" },
          },
        ],
      },
    },
    { service: { startSessionOwned: (request) => Effect.succeed(launched(request, "agent-1")) } },
  );
  const customAgents = yield* scenario(
    "one custom agent launch, one unknown agent",
    {
      tool: "agent_start",
      args: {
        agents: [
          { name: "auth-review", agent: "auth-reviewer", task: "Review the session refresh flow" },
          { name: "docs-sweep", agent: "docs-writer", task: "Find stale refreshToken references" },
        ],
      },
    },
    {
      profiles: agentRoutes,
      service: { startSessionOwned: (request) => Effect.succeed(launched(request, "agent-1")) },
    },
  );
  const promptFailures: ToolScenario[] = [];
  for (const uncertain of [false, true]) {
    promptFailures.push(
      yield* scenario(
        uncertain ? "task admission unconfirmed" : "input hook handled the task",
        {
          tool: "agent_start",
          args: {
            agents: [{ name: "task-review", profile: "reviewer", task: "Review the change" }],
          },
        },
        {
          service: {
            startSessionOwned: () =>
              Effect.fail(
                SubagentProcessError.make({
                  operation: "start",
                  code: uncertain ? "prompt_outcome_uncertain" : "prompt_not_delivered",
                  ...failureFields(
                    uncertain
                      ? withGuidanceClause(
                          "Subagent did not confirm task admission.\nThe task may already have started",
                          "inspect the run with agent_read before retrying.",
                        )
                      : "Subagent did not admit the task.\nAn input hook or slash command handled it before it reached the model.",
                  ),
                }),
              ),
          },
        },
      ),
    );
  }
  return [
    settled,
    still,
    modelOverride,
    customAgents,
    blockedWriter,
    blockedDescendant,
    ...promptFailures,
  ];
});

const awaitInput: SubagentToolInput<"agent_await"> = {
  tool: "agent_await",
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
    result: cancellation.cancelled(0),
  };
  const userInput: ToolScenario = {
    tool: awaitInput.tool,
    title: "user sent a message",
    args: awaitInput.args,
    result: cancellation.cancelled(0, false, { kind: "user_input" }),
  };
  const siblingQuestion = yield* scenario("another worker asks a question", awaitInput, {
    service: {
      withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
        Effect.suspend(() =>
          use(
            [
              { run: authReview },
              { run: { ...docsSweep, state: "running", finalText: undefined } },
            ],
            [dbMigration],
          ),
        ),
    },
  });
  const agentMessage = yield* scenario("another agent messages you", awaitInput, {
    service: {
      withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
        Effect.suspend(() =>
          use(
            [
              { run: { ...authReview, state: "running", finalText: undefined } },
              { run: { ...docsSweep, state: "running", finalText: undefined } },
            ],
            [],
            {
              count: 1,
              arrivals: [
                {
                  from: dbMigration.id,
                  fromName: dbMigration.name,
                  text: "The sessions table gains a refresh_expires_at column; auth-review should check it.",
                  truncated: false,
                },
              ],
            },
          ),
        ),
    },
  });
  const cutReport = yield* scenario(
    "a long report is cut and saved to a file",
    { tool: "agent_await", args: { runIds: ["agent-1"], until: "all_finished" } },
    {
      service: {
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
          use([
            {
              run: {
                ...authReview,
                state: "completed" as const,
                finalText: Fn.pipe(
                  "Finding 1: session.ts:118 swallows a timeout.\n",
                  Str.repeat(600),
                ),
                finalTextTruncation: {
                  retainedChars: 28_200,
                  originalChars: 152_310,
                  originalLines: 3_172,
                },
                reportArchive: {
                  path: "/home/me/.pi/agent/subagents/reports/session-1/agent-1-1-4f1c.md",
                  chars: 152_310,
                  lines: 3_172,
                  complete: true,
                },
                ...timing(4, 0.5),
              },
            },
          ]),
      },
    },
  );
  return [live, settled, cancelled, userInput, siblingQuestion, agentMessage, cutReport];
});

const candidate = (overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
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

const agentRoutes = profileServiceFor({
  profiles: {
    reviewer: [candidate({ model: "openai/retired-model" }), candidate()],
  },
  agents: {
    "auth-reviewer": {
      description: "Reviews authentication changes against the threat model.",
      instructions: "Review only authentication code and cite file and line for every finding.",
      profile: "reviewer",
      effort: "xhigh",
      tools: { deny: ["bash"] },
    },
    broken: { description: "Missing its instructions." },
  },
});

const modelScenarios = Effect.all([
  scenario(
    "all profile routes",
    { tool: "agent_profiles", args: {} },
    { profiles: configuredRoutes },
  ),
  scenario(
    "one profile route",
    { tool: "agent_profiles", args: { profile: "reviewer" } },
    { profiles: configuredRoutes },
  ),
  scenario(
    "profile routes with custom agents",
    { tool: "agent_profiles", args: {} },
    { profiles: agentRoutes },
  ),
]);

const agentScenario = (title: string, input: AgentToolInput, service: SubagentServiceDoubleInput) =>
  executeAgentActionEffect(input, { kind: "main" }, false, runtime.environment.cwd).pipe(
    Effect.map((result) => ({ result, isError: false })),
    Effect.catch((error) => Effect.succeed({ result: rejectedResult(error), isError: true })),
    Effect.provideService(SubagentService, subagentServiceDouble(service)),
    Effect.map(
      (executed): ToolScenario => ({ tool: input.tool, title, args: input.args, ...executed }),
    ),
  );

const listEntry = (run: SubagentRunView): AgentListEntry => ({
  id: run.id,
  name: run.name,
  kind: "run",
  state: run.state,
  parentId: run.parentRunId ?? "main",
  depth: run.depth ?? 1,
  ...(run.profile && { profile: run.profile }),
  task: run.task,
  self: false,
  run,
});
const runReadout = (run: SubagentRunView, text?: string): AgentReadout => ({
  kind: "run",
  id: run.id,
  name: run.name,
  state: run.state,
  ...(text === undefined
    ? { textStatus: "none" }
    : {
        textStatus: "text",
        text,
        source: run.finalText === text ? "report" : run.error === text ? "error" : "assistant",
      }),
  truncated: false,
  reportGeneration: run.reportGeneration,
  run,
});
const read = (agents: ReadonlyArray<AgentReadout>, missingIds: ReadonlyArray<string> = []) => ({
  agentRead: () => Effect.succeed({ agents, missingIds }),
});
const sessionAgents: ReadonlyArray<AgentListEntry> = [
  { id: "main", name: "main", kind: "main", state: "busy", self: true },
  ...Arr.map([authReview, schemaCheck, docsSweep, apiAudit], listEntry),
];
const sent = (
  to: string,
  name: string,
  disposition: AgentSendResult["disposition"],
  delivery: Partial<Pick<AgentSendResult, "mainState" | "parked">> = {},
) => ({
  agentSend: () => Effect.succeed({ messageId: "message-1", to, name, disposition, ...delivery }),
});
const peerNote = "The refresh test fixtures moved to tests/auth/fixtures; update your imports.";

const agentScenarios = Effect.all([
  agentScenario(
    "every agent in the session",
    { tool: "agent_list", args: {} },
    { agentList: () => Effect.succeed({ agents: sessionAgents, missingIds: [] }) },
  ),
  agentScenario(
    "fleet with a nested worker, a question, a pause, and a proposal",
    { tool: "agent_list", args: {} },
    {
      agentList: () =>
        Effect.succeed({
          agents: [
            { id: "main", name: "main", kind: "main", state: "busy", self: true },
            ...Arr.map([authReview, schemaCheck, dbMigration, migrationReview], listEntry),
            listEntry({ ...docsSweep, state: "paused" }),
            listEntry({ ...worktreeProposal, workspaceOutcome: proposalOutcome }),
          ],
          missingIds: [],
        }),
    },
  ),
  agentScenario(
    "one requested agent is gone",
    { tool: "agent_list", args: { agentIds: ["agent-1", "agent-7"] } },
    {
      agentList: () => Effect.succeed({ agents: [listEntry(authReview)], missingIds: ["agent-7"] }),
    },
  ),
  agentScenario(
    "guidance to a running peer",
    { tool: "agent_send", args: { to: "agent-4", message: peerNote } },
    sent("agent-4", "schema-check", "guided"),
  ),
  agentScenario(
    "message wakes the idle main agent",
    { tool: "agent_send", args: { to: "main", message: "Schema check finished; see my report." } },
    sent("main", "main", "guided", { mainState: "idle" }),
  ),
  agentScenario(
    "message queued for the busy main agent",
    { tool: "agent_send", args: { to: "main", message: "The CLI flags changed too." } },
    sent("main", "main", "guided", { mainState: "busy" }),
  ),
  agentScenario(
    "main agent holds messages behind a dialog or after an interrupt",
    { tool: "agent_send", args: { to: "main", message: "Done with the audit." } },
    sent("main", "main", "guided", { mainState: "held" }),
  ),
  agentScenario(
    "guidance waits behind another agent's question",
    { tool: "agent_send", args: { to: "agent-6", message: peerNote } },
    sent("agent-6", "db-migration", "guided", { parked: true }),
  ),
  agentScenario(
    "reply to a child's question",
    { tool: "agent_send", args: { to: "agent-6", message: "Yes, claim src/db/seed.ts." } },
    sent("agent-6", "db-migration", "answered"),
  ),
  agentScenario(
    "reply already in flight",
    { tool: "agent_send", args: { to: "agent-6", message: "Yes, go ahead." } },
    {
      agentSend: (_caller, to) =>
        Effect.fail(
          InvalidSubagentRequestError.make({
            code: "reply_in_flight",
            ...failureFields(
              withGuidanceClause(
                `Subagent ${to} already has a parent reply in flight`,
                "inspect it with agent_read before sending again.",
              ),
            ),
          }),
        ),
    },
  ),
  agentScenario(
    "reply unconfirmed",
    { tool: "agent_send", args: { to: "agent-6", message: "Yes, claim src/db/seed.ts." } },
    {
      agentSend: (_caller, to) =>
        Effect.fail(
          SubagentProcessError.make({
            operation: "reply",
            code: "reply_outcome_uncertain",
            ...failureFields(
              withCause(
                withGuidance(
                  `The reply to subagent ${to} may already have applied.`,
                  "Inspect it with agent_read before retrying.",
                ),
                { message: "Transport closed before acknowledgement." },
              ),
            ),
          }),
        ),
    },
  ),
  agentScenario(
    "message resumes a finished run",
    { tool: "agent_send", args: { to: "agent-2", message: "Also check docs/cli.md." } },
    sent("agent-2", "docs-sweep", "resumed"),
  ),
  agentScenario(
    "agent unavailable",
    { tool: "agent_send", args: { to: "agent-1", message: "Ping again." } },
    {
      agentSend: () =>
        Effect.fail(
          agentMessageRefusal(
            "agent_unavailable",
            "Agent agent-1 is stopping and can't receive messages.",
          ),
        ),
    },
  ),
  agentScenario(
    "main and a finished run",
    { tool: "agent_read", args: { agentIds: ["main", "agent-2"] } },
    {
      agentRead: () =>
        Effect.succeed({
          agents: [
            {
              kind: "main",
              id: "main",
              name: "main",
              state: "busy",
              textStatus: "text",
              text: "I'm splitting the auth review: agent-1 covers refresh, agent-4 the schema.\nNext I'll merge their findings.",
              truncated: false,
            },
            {
              kind: "run",
              id: docsSweep.id,
              name: docsSweep.name,
              state: "completed",
              textStatus: "text",
              text: docsSweep.finalText,
              truncated: false,
              source: "report",
              reportGeneration: 1,
              run: docsSweep,
            },
          ],
          missingIds: [],
        }),
    },
  ),
  agentScenario(
    "running agent without a message yet",
    { tool: "agent_read", args: { agentIds: ["agent-4"] } },
    read([runReadout(schemaCheck)]),
  ),
  agentScenario(
    "failed worker with a next candidate",
    { tool: "agent_read", args: { agentIds: ["agent-5"] } },
    read([runReadout(migrationReview, migrationReview.error)]),
  ),
  agentScenario(
    "child waiting on its parent's reply",
    { tool: "agent_read", args: { agentIds: ["agent-6"] } },
    read([runReadout(dbMigration, "Which seed file should I extend?")]),
  ),
  agentScenario(
    "one worker not found",
    { tool: "agent_read", args: { agentIds: ["agent-2", "agent-12"] } },
    read([runReadout(docsSweep, docsSweep.finalText)], ["agent-12"]),
  ),
  agentScenario(
    "finished worktree writer with verbose details",
    { tool: "agent_read", args: { agentIds: ["agent-10"], verbose: true } },
    {
      // The worktree fixtures are declared with the workspace scenarios below.
      agentRead: () =>
        Effect.sync(() => ({
          agents: [
            runReadout(
              { ...worktreeProposal, workspaceOutcome: proposalOutcome },
              worktreeProposal.finalText,
            ),
          ],
          missingIds: [],
        })),
    },
  ),
]);

const agentMessage = (
  title: string,
  from: SubagentRunView | undefined,
  text: string,
  saved: "current" | "without display copy" = "current",
) => {
  const details = agentMessageDetails({
    from: from?.id ?? "main",
    fromName: from?.name ?? "main",
    to: "main",
    messageId: "message-1",
    content: "",
    text,
  });
  const { text: _text, ...historical } = details;
  return {
    title,
    message: {
      role: "custom" as const,
      timestamp: 0,
      customType: AGENT_MESSAGE_TYPE,
      display: true,
      content: agentMessageContent(from ? runSender(from) : MAIN_AGENT_SENDER, text),
      details: saved === "current" ? details : historical,
    },
  };
};
const agentMessageScenarios: ReadonlyArray<GalleryMessageScenario> = [
  agentMessage(
    "peer reports a finding",
    schemaCheck,
    `${peerNote}\nI kept the old paths as re-exports.`,
  ),
  agentMessage(
    "a long message is bounded collapsed",
    dbMigration,
    Arr.join(
      Arr.map(
        Arr.range(1, 14),
        (line) => `Step ${line}: migrated table_${line} and verified its indexes.`,
      ),
      "\n",
    ),
  ),
  agentMessage("saved before display copies", schemaCheck, peerNote, "without display copy"),
];

const lifecycleScenarios = Effect.all([
  scenario(
    "stop two workers",
    { tool: "agent_lifecycle", args: { action: "stop", runIds: ["agent-1", "agent-4"] } },
    {
      service: {
        stop: (id) => updated(id, { state: id === "agent-4" ? "stopping" : "stopped" }),
      },
    },
  ),
  scenario(
    "stop a missing worker",
    { tool: "agent_lifecycle", args: { action: "stop", runIds: ["agent-1", "agent-12"] } },
    { service: { stop: (id) => updated(id, { state: "stopped" }) } },
  ),
  scenario(
    "interrupt",
    { tool: "agent_lifecycle", args: { action: "interrupt", runIds: ["agent-1"] } },
    { service: { interrupt: (id) => updated(id, { state: "paused" }) } },
  ),
  scenario(
    "interrupt already pending",
    { tool: "agent_lifecycle", args: { action: "interrupt", runIds: ["agent-3"] } },
    {
      service: {
        interrupt: (id) =>
          Effect.fail(
            InvalidSubagentRequestError.make({
              code: "interrupt_in_flight",
              message: `Subagent ${id} already has an interrupt pending.`,
            }),
          ),
      },
    },
  ),
]);

const reviewedPatch = Arr.join(
  [
    "diff --git a/db/0007.sql b/db/0007.sql",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/db/0007.sql",
    "@@ -0,0 +1,2 @@",
    "+ALTER TABLE sessions ADD COLUMN rotated_at timestamptz;",
    "+CREATE INDEX sessions_rotated_at ON sessions (rotated_at);",
  ],
  "\n",
);
const reviewPage = revisionReviewText({
  revisionId: "rev-1",
  changedPaths: ["db/0007.sql"],
  uncapturedPaths: [".env.local"],
  diff: reviewedPatch,
});
const workspaceRecord: WorkspaceRecord = {
  version: 2,
  repository: "/project/.git",
  handle: {
    workspaceId: "ws-1",
    ownerId: "root",
    sourceCwd: "/project",
    sourceRoot: "/project",
    artifactRoot: "/project/.pi-subagents/worktrees/ws-1",
    cwd: "/project/.pi-subagents/worktrees/ws-1",
  },
  status: "frozen",
  baseline: "4f2a9c1",
  ownerLease: "owner-1",
  lastChangedAt: 0,
  revision: { revisionId: "rev-1", changedPaths: ["db/0007.sql"] },
};
const proposalOutcome = {
  status: "proposal",
  changedFileCount: 3,
  uncapturedFileCount: 1,
  diffStat: {
    addedLines: 48,
    deletedLines: 7,
    files: [
      { path: "src/auth/session.ts", addedLines: 31, deletedLines: 7 },
      { path: "tests/auth/session.test.ts", addedLines: 17, deletedLines: 0 },
      { path: "assets/refresh.png", addedLines: 0, deletedLines: 0, binary: true },
    ],
  },
} as const;
const appliedWorkspace = {
  revisionId: "rev-1",
  preparationId: "prep-2",
  preparedCwd: "/project/.pi-subagents/prepared/prep-2",
  changedPaths: ["db/0007.sql", "src/db/schema.ts"],
  changedPathCount: 2,
  leftOutPaths: [],
  workerRoot: "/agent/subagent-worktrees/ws-1/worker",
  untouchedDriftPaths: [],
  treeRemovalFailed: false,
  leaseReleaseUnconfirmed: false,
} as const;
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
      text: reviewPage,
      offset: 0,
      totalChars: reviewPage.length + 16_000,
      nextOffset: reviewPage.length,
    }),
  workspacePrepare: (_workspaceId, revisionId) =>
    Effect.succeed({
      preparationId: "prep-1",
      revisionId,
      cwd: "/project/.pi-subagents/prepared/prep-1",
      leftOutPaths: [],
    }),
  workspaceApply: () =>
    Effect.succeed({
      ...appliedWorkspace,
      testing: "parent-tested",
    }),
  workspaceDiscard: () => Effect.void,
  workspaceRevise: () =>
    Effect.succeed({
      run: view({ id: "agent-10", name: "db-migration", profile: "worker", writeIntent: "writer" }),
    }),
};
const leftoverWorkspace: SubagentServiceDoubleInput = {
  workspaceApply: () =>
    Effect.succeed({
      ...appliedWorkspace,
      testing: "parent-tested",
      untouchedDriftPaths: ["src/billing.ts", "README.md"],
      leaseReleaseUnconfirmed: true,
    }),
};
const untestedApply: SubagentServiceDoubleInput = {
  workspaceApply: () =>
    Effect.succeed({
      ...appliedWorkspace,
      testing: "untested",
      leftOutPaths: [".env.local", "certs/dev.pem"],
    }),
};
const orphanedWorkspaces: SubagentServiceDoubleInput = {
  workspaceList: () =>
    Effect.succeed({
      records: [
        { ...workspaceRecord, handle: { ...workspaceRecord.handle, ownerId: "ended/root" } },
        {
          ...workspaceRecord,
          status: "integrating",
          handle: { ...workspaceRecord.handle, workspaceId: "ws-3", ownerId: "ended/root" },
        },
      ],
      unavailable: [],
      orphans: new Map([
        ["ws-1", "adoptable" as const],
        ["ws-3", "discard-only" as const],
      ]),
    }),
};
const staleWorkspace: SubagentServiceDoubleInput = {
  workspacePrepare: () =>
    Effect.fail(
      InvalidSubagentRequestError.make({
        code: "workspace_revision_stale",
        message: "The immutable workspace revision no longer matches.",
      }),
    ),
};

const workspaceScenarios = Effect.all([
  scenario(
    "list proposals",
    { tool: "agent_worktree", args: { action: "list" } },
    { service: workspaceService },
  ),
  scenario(
    "review the first page, led by its summary",
    { tool: "agent_worktree", args: { action: "review", workspaceId: "ws-1" } },
    { service: workspaceService },
  ),
  scenario(
    "prepare a combined tree",
    {
      tool: "agent_worktree",
      args: { action: "prepare", workspaceId: "ws-1", revisionId: "rev-1" },
    },
    { service: workspaceService },
  ),
  scenario(
    "apply the preparation you tested",
    {
      tool: "agent_worktree",
      args: { action: "apply", workspaceId: "ws-1", revisionId: "rev-1" },
    },
    { service: workspaceService },
  ),
  scenario(
    "apply a preparation leaving files and the source lock behind",
    {
      tool: "agent_worktree",
      args: { action: "apply", workspaceId: "ws-1", revisionId: "rev-1" },
    },
    { service: leftoverWorkspace },
  ),
  scenario(
    "apply an untested proposal",
    { tool: "agent_worktree", args: { action: "apply", workspaceId: "ws-1" } },
    { service: untestedApply },
  ),
  scenario(
    "apply refused by a failing WorktreeCreate hook",
    { tool: "agent_worktree", args: { action: "apply", workspaceId: "ws-1" } },
    {
      service: {
        workspaceApply: () =>
          Effect.fail(
            InvalidSubagentRequestError.make({
              code: "workspace_hook_failed",
              message:
                "WorktreeCreate hook `pnpm install --offline --frozen-lockfile` exited with code 1: ERR_PNPM_NO_OFFLINE_TARBALL",
            }),
          ),
      },
    },
  ),
  scenario(
    "list workspaces left by an ended session",
    { tool: "agent_worktree", args: { action: "list" } },
    { service: orphanedWorkspaces },
  ),
  scenario(
    "request a revision",
    {
      tool: "agent_worktree",
      args: { action: "revise", workspaceId: "ws-1", message: "Add a down migration." },
    },
    { service: workspaceService },
  ),
  scenario(
    "request a rebased revision with conflicts",
    {
      tool: "agent_worktree",
      args: {
        action: "revise",
        workspaceId: "ws-1",
        message: "Build on the new schema module.",
        rebase: true,
      },
    },
    {
      service: {
        workspaceRevise: () =>
          Effect.succeed({
            run: view({
              id: "agent-11",
              name: "db-migration",
              profile: "worker",
              writeIntent: "writer",
            }),
            rebase: {
              reappliedPaths: ["db/0007.sql", "src/db/schema.ts"],
              conflictedPaths: ["src/db/schema.ts"],
            },
          }),
      },
    },
  ),
  scenario(
    "rebase refused when changes can't be reapplied",
    {
      tool: "agent_worktree",
      args: { action: "revise", workspaceId: "ws-1", message: "Retry.", rebase: true },
    },
    {
      service: {
        workspaceRevise: () =>
          Effect.fail(
            mapWorkspaceError(
              WorkspaceError.make({
                operation: "rebase",
                code: "workspace_rebase_refused",
                message: "The previous changes can't be reapplied to the parent's current files.",
                detail:
                  'Unmergeable: "src/db/legacy.ts"\nNothing was changed; the workspace keeps its worker tree and revision.',
                remedy:
                  "revise without rebase, or apply the proposal and start a new writer from the current checkout.",
              }),
            ),
          ),
      },
    },
  ),
  scenario(
    "discard",
    { tool: "agent_worktree", args: { action: "discard", workspaceId: "ws-1" } },
    { service: workspaceService },
  ),
  scenario(
    "discard blocked by a reader in an older preparation",
    { tool: "agent_worktree", args: { action: "discard", workspaceId: "ws-1" } },
    {
      service: {
        workspaceDiscard: () =>
          Effect.fail(
            invalidRequest(
              "workspace_process_unsettled",
              withGuidance(
                "A run still uses this workspace.",
                "Stop it and confirm cleanup before discard.",
              ),
            ),
          ),
      },
    },
  ),
  scenario(
    "prepare refused by a timed-out WorktreeCreate hook",
    {
      tool: "agent_worktree",
      args: { action: "prepare", workspaceId: "ws-1", revisionId: "rev-1" },
    },
    {
      service: {
        workspacePrepare: () =>
          Effect.fail(
            InvalidSubagentRequestError.make({
              code: "workspace_hook_failed",
              message:
                "WorktreeCreate hook `pnpm install --offline --frozen-lockfile` timed out after 600s: Progress: resolved 412, reused 398",
            }),
          ),
      },
    },
  ),
  scenario(
    "stale revision",
    {
      tool: "agent_worktree",
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
  tool: "agent_await",
  title,
  args: { runIds: Arr.map(runs, (run) => run.id), until: "all_finished" },
  result: {
    content: [{ type: "text", text: "Agent-facing await report" }],
    details: awaitDetails({ runs, awaitUntil: "all_finished", ...extra }),
  },
});

const route = {
  profile: "reviewer",
  routeStatus: "selected",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  openaiFastMode: false,
} as const;

const receiptScenarios: ReadonlyArray<ToolScenario> = [
  {
    tool: "agent_start",
    title: "malformed arguments rejected by Pi",
    args: {},
    isError: true,
    result: textResult(
      piArgumentRejection(
        { name: "agent_start", parameters: SUBAGENT_TOOL_SCHEMAS.agent_start.parameters },
        '{"agents":[{"name":"auth-review","task":"Review the session refresh',
      ),
    ),
  },
  {
    tool: "agent_start",
    title: "expanded writer task",
    args: {
      agents: [
        {
          name: "refresh-fix",
          profile: "worker",
          task: Arr.join(
            [
              "Fix the session refresh timeout handling.",
              "Preserve the caller's cancellation and keep late responses from updating a newer session.",
              "Add a regression for a refresh response arriving after a session switch.",
              "Keep changes to src/auth/session.ts and tests/auth/session.test.ts; report any other required changes to the parent.",
            ],
            "\n",
          ),
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
  awaited("worker and system warnings", [
    view({
      state: "completed",
      finalText: "Done.",
      warning: "Could not run the integration tests: docker is not available",
      systemWarning: "Context window 91% full",
    }),
  ]),
  awaited(
    "completed writer with cleanup quarantine",
    [
      view({
        name: "cleanup-worker",
        state: "completed",
        finalText: "Finished the requested changes; focused tests passed.",
        writeIntent: "writer",
        cleanup: {
          disposition: "quarantined",
          recovery: "stop",
          diagnostic: {
            phase: "process-group",
            code: "process_cleanup_unconfirmed",
            message:
              "The worker finished, but a descendant process group could not be verified absent.\nVerification evidence is retained; a stop request can recheck without restarting work.",
          },
        },
        writerCleanupQuarantined: true,
      }),
    ],
    { attentionRequired: true },
  ),
  awaited(
    "stopped writer with manual cleanup quarantine",
    [
      view({
        writeIntent: "writer",
        state: "stopped",
        finalText: "Completed report retained for review.",
        cleanup: {
          disposition: "quarantined",
          recovery: "manual",
          diagnostic: {
            phase: "writer-lease",
            code: "lease_release_unconfirmed",
            message:
              "Lease release failed with an uncertain outcome; preserve held resources for manual inspection.",
          },
        },
        writerCleanupQuarantined: true,
      }),
    ],
    { attentionRequired: true },
  ),
  {
    tool: "agent_lifecycle",
    title: "stop verified this member but another cleanup still quarantines the pool",
    args: { action: "stop", runIds: ["agent-1"] },
    result: {
      content: [],
      details: compactToolDetails({
        action: "stop",
        runs: [
          view({
            state: "completed",
            cleanup: { disposition: "confirmed" },
            writerCleanupQuarantined: true,
          }),
        ],
      }),
    },
  },
  awaited("writer finished with a proposal", [
    view({
      state: "completed",
      writeIntent: "writer",
      writerWorkspaceMode: "worktree",
      workspaceId: "ws-1",
      workspaceOutcome: proposalOutcome,
      finalText: "Implemented.",
    }),
  ]),
  awaited("writer changed nothing, so its workspace was discarded", [
    view({
      state: "completed",
      writeIntent: "writer",
      writerWorkspaceMode: "worktree",
      workspaceId: "ws-1",
      workspaceOutcome: { status: "auto-discarded" },
      finalText: "No changes were needed; the timeout is already configured.",
    }),
  ]),
  ...Arr.map(["integrated", "discarded"] as const, (status) =>
    awaited(`writer's proposal was ${status === "integrated" ? "applied" : "discarded"}`, [
      view({
        state: "completed",
        writeIntent: "writer",
        writerWorkspaceMode: "worktree",
        workspaceId: "ws-1",
        workspaceOutcome: { status },
        finalText: "Implemented.",
      }),
    ]),
  ),
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
    tool: "agent_start",
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
              nextCandidate: { model: "anthropic/claude-opus-4-7", effort: "high" },
            },
          },
        ],
      }),
    },
  },
  {
    tool: "agent_start",
    title: "a launch fails with a saved failure and a warning",
    args: { agents: [{ name: "auth-review", task: "Review auth" }] },
    isError: true,
    result: {
      content: [{ type: "text" as const, text: "Agent-facing launch report" }],
      details: startDetails({
        startEntries: [
          { ...route, index: 0, name: "auth-review", status: "failed", candidateIndex: 0 },
        ],
        startFailures: [
          {
            index: 0,
            name: "auth-review",
            code: "start_failed_before_prompt",
            message: `Provider rejected the session: ${Fn.pipe("quota detail ", Str.repeat(30))}`,
            admittedRun: {
              runId: "agent-1",
              cleanupDisposition: "confirmed",
              nextCandidate: "none",
              failureFile: {
                path: "/home/me/.pi/agent/subagent-reports/session-1/agent-1-1-failure.md",
                chars: 420,
                lines: 1,
                complete: true,
              },
              warning: "System warning: The provider rate-limited startup; retried twice.",
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
      name: "agent_contact_parent",
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
): ToolScenario => ({ tool: "agent_contact_parent", title, args: { kind, message }, ...overrides });

const parentScenarios: ReadonlyArray<ToolScenario> = [
  contact("progress", "progress", progressNote, {
    result: textResult("Parent received progress."),
  }),
  contact("warning", "warning", warningNote, { result: textResult("Parent received warning.") }),
  contact("question waiting for a reply", "question", questionNote, { phase: "running" }),
  contact("question answered", "question", questionNote, {
    result: textResult("Parent reply: No backfill; leave existing rows null."),
  }),
  contact("question cancelled", "question", questionNote, {
    isError: true,
    result: textResult("Parent question was cancelled."),
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
  return Arr.map(messages, (message): GalleryMessageScenario => ({ title, message }));
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
  ...(run.workspaceId !== undefined && { workspaceId: run.workspaceId }),
  ...overrides,
});

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

const completedReports = notified("one worker reports", {
  type: "completed",
  runs: [completion(docsSweep)],
});
const messageScenarios: ReadonlyArray<GalleryMessageScenario> = [
  ...completedReports,
  ...notified("one worker reports a short saved report", {
    type: "completed",
    runs: [
      completion(docsSweep, {
        reportArchive: {
          path: "/home/me/.pi/agent/subagents/reports/session-1/agent-2-1-9b2e.md",
          chars: docsSweep.finalText?.length ?? 0,
          lines: 5,
          complete: true,
        },
      }),
    ],
  }),
  ...notified("one worker fails with a next candidate", {
    type: "completed",
    runs: [completion(migrationReview, { nextCandidate: migrationReview.nextCandidate })],
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
  ...notified("worktree writers finish with a proposal and with no changes", {
    type: "completed",
    runs: [
      completion(worktreeProposal, {
        workspaceOutcome: proposalOutcome,
      }),
      completion(
        {
          ...worktreeProposal,
          id: "agent-11",
          name: "lint-check",
          workspaceId: "ws-2",
          finalText: "Nothing to fix.",
        },
        { workspaceOutcome: { status: "auto-discarded" } },
      ),
    ],
  }),
  ...notified("worktree writer finishes before its proposal is counted", {
    type: "completed",
    runs: [completion(worktreeProposal)],
  }),
  ...notified("worktree writer changed nothing", {
    type: "completed",
    runs: [
      completion(
        {
          ...worktreeProposal,
          id: "agent-11",
          name: "lint-check",
          workspaceId: "ws-2",
          finalText: "Nothing to fix.",
        },
        { workspaceOutcome: { status: "auto-discarded" } },
      ),
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
    title: "reloading Pi stops workers",
    message: {
      role: "custom",
      customType: STOPPED_RUNS_MESSAGE_TYPE,
      display: true,
      timestamp: 0,
      content: stoppedRunsContent([authReview, dbMigration], "reload"),
      details: stoppedRunsDetails([authReview, dbMigration], "reload"),
    },
  },
  ...Arr.map(completedReports, ({ message }) => ({
    title: "forwarded to a nested worker",
    message: { ...message, customType: "pi-subagents-proxy-notification" },
  })),
  ...Arr.map(completedReports, ({ message }) => ({
    title: "forwarded before display copies",
    message: { ...message, customType: "pi-subagents-proxy-notification", details: undefined },
  })),
  {
    title: "peer notice",
    message: {
      role: "custom",
      customType: "pi-subagents-peer-notice",
      display: true,
      timestamp: 0,
      content: Arr.join(
        [
          "Your current ownership summary: read-only.",
          "",
          "You share this working directory with 1 other active subagent:",
          "",
          "- db-migration (agent-6): shared-checkout writer; running; task: Implement the 0007 migration",
          "",
          "Shared-checkout writers coordinate by task scope: never edit files that belong to a peer's task. Before work that could overlap a running peer's task, agree on it with that peer through agent_send, and tell peers about changes they depend on. Ask the parent if you can't agree.",
        ],
        "\n",
      ),
      details: {
        version: 1,
        kind: "peers",
        ownership: "read-only",
        peers: [
          {
            id: dbMigration.id,
            name: dbMigration.name,
            ownership: "shared-checkout writer",
            state: "running",
            task: dbMigration.task,
          },
        ],
        total: 1,
      },
    },
  },
];

const activityRowLine = (item: ActivityItem): string => {
  const head = Arr.join(
    Arr.filter(
      [item.status, item.kind, item.title, item.profile, item.summary],
      (part): part is string => Boolean(part),
    ),
    " · ",
  );
  const actions = item.actions?.length
    ? `  [${Arr.join(
        Arr.map(item.actions, (action) => action.label),
        ", ",
      )}]`
    : "";
  return `${item.parent ? "  " : ""}${head}${actions}`;
};

interface ActivityScenario {
  readonly title: string;
  readonly runs: ReadonlyArray<SubagentRunView>;
  readonly details: ReadonlyArray<string>;
}

const activityScenarios: ReadonlyArray<ActivityScenario> = [
  {
    title: "active agents with descendants and completed reports",
    runs: [authReview, docsSweep, apiAudit, schemaCheck],
    details: [authReview.id, docsSweep.id, schemaCheck.id],
  },
  {
    title: "a writer question and a stopped writer",
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
    title: "worktree writers with a proposal and an automatic discard",
    runs: [
      {
        ...worktreeProposal,
        workspaceOutcome: proposalOutcome,
      },
      {
        ...worktreeProposal,
        id: "agent-11",
        name: "lint-check",
        finalText: "Nothing to fix.",
        workspaceOutcome: { status: "auto-discarded" },
      },
    ],
    details: [worktreeProposal.id, "agent-11"],
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
    title: "a paused reviewer beside a writer question",
    runs: [{ ...authReview, state: "paused" }, dbMigration],
    details: [authReview.id, dbMigration.id],
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
  Arr.flatMap(activityScenarios, (activity) => {
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
      Arr.map(items, activityRowLine),
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
    sessionEvents: Arr.map(["t1", "t2", "t3"], (toolCallId, index) => ({
      type: "tool" as const,
      toolCallId,
      toolName: "edit",
      state: "failed" as const,
      startedAt: minutesAgo(1) + index,
      endedAt: minutesAgo(1) + index + 1,
    })),
  }),
];

const messagingRuns: ReadonlyArray<SubagentRunView> = [
  view({
    id: "agent-0000000001",
    name: "pinger",
    state: "running",
    startedAt: minutesAgo(4),
    lastActivityAt: now - 2_000,
    currentTool: "read src/app.ts",
    messageCount: 3,
    sessionEvents: [
      {
        type: "notice",
        kind: "message",
        direction: "out",
        peer: "agent-0000000002",
        text: "hello from pinger",
        createdAt: now - 2_000,
      },
    ],
  }),
  view({
    id: "agent-0000000002",
    name: "ponger",
    state: "running",
    startedAt: minutesAgo(4),
    lastActivityAt: now - 2_000,
    currentTool: "grep /TODO/ src",
    messageCount: 2,
    sessionEvents: [
      {
        type: "notice",
        kind: "message",
        direction: "in",
        peer: "agent-0000000001",
        text: "hello from pinger",
        createdAt: now - 2_000,
      },
    ],
  }),
  view({
    id: "agent-0000000003",
    name: "quiet-peer",
    state: "running",
    startedAt: minutesAgo(3),
    lastActivityAt: now,
    currentTool: "bash pnpm test",
    messageCount: 1,
    sessionEvents: [
      {
        type: "notice",
        kind: "message",
        direction: "in",
        peer: "main",
        text: "an older message past the recent window",
        createdAt: minutesAgo(2),
      },
    ],
  }),
];

const widgetFrames = (
  title: string,
  runs: ReadonlyArray<SubagentRunView>,
): ReadonlyArray<string> => {
  const panel = projectSubagentActivityPanel({ revision: 1, runs });
  return [`── widget · ${title}`].concat(
    Arr.flatMap([60, 100], (width) =>
      [`width ${width}`].concat(
        renderProjectedSubagentActivityPanel(panel, width, plainTheme, now),
        [""],
      ),
    ),
  );
};

const widgetLines = (): ReadonlyArray<string> => [
  ...widgetFrames("stalled children (tool open, silent, failing tools)", stalledRuns),
  ...widgetFrames("agent messages (recent message, counts, expired message)", messagingRuns),
  ...widgetFrames("a question and a paused run", [{ ...authReview, state: "paused" }, dbMigration]),
];

const BACKGROUNDS = ["border", "on", "off"] as const;

const titled = <A extends { readonly title: string }>(entries: ReadonlyArray<A>, title: string) =>
  Option.getOrThrow(Arr.findFirst(entries, (entry) => entry.title === title));

/** A short turn: a launch, its report, a message sent and received, and a question. */
const transcriptEntries = (
  tools: ReadonlyArray<ToolDefinition>,
  scenarios: ReadonlyArray<ToolScenario>,
): ReadonlyArray<GalleryTranscriptEntry> => {
  const toolRow = (title: string): GalleryTranscriptEntry => {
    const entry = titled(scenarios, title);
    return {
      name: entry.tool,
      tool: Option.getOrThrow(Arr.findFirst(tools, (tool) => tool.name === entry.tool)),
      args: entry.args,
      result: { ...entry.result!, isError: entry.isError ?? false },
    };
  };
  const message = (
    render: typeof renderSubagentMessage,
    entries: ReadonlyArray<GalleryMessageScenario>,
    title: string,
  ): GalleryTranscriptEntry => ({ render, message: titled(entries, title).message });
  return [
    toolRow("two launches start"),
    message(renderSubagentMessage, messageScenarios, "one worker reports"),
    toolRow("guidance to a running peer"),
    message(renderAgentMessageEntry, agentMessageScenarios, "peer reports a finding"),
    message(renderSubagentMessage, messageScenarios, "worker needs a reply"),
  ];
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
        ...(yield* lifecycleScenarios),
        ...(yield* workspaceScenarios),
        ...(yield* agentScenarios),
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
              ...galleryFrames(
                Option.getOrUndefined(
                  Arr.findFirst(tools, (definition) => definition.name === tool),
                )!,
                {
                  ...entry,
                  title: `${style} · ${tool} · ${entry.title}`,
                },
              ),
            );
          for (const entry of messageScenarios)
            lines.push(
              ...galleryMessageFrames(renderSubagentMessage, {
                ...entry,
                title: `${style} · ${entry.message.customType} · ${entry.title}`,
              }),
            );
          for (const entry of agentMessageScenarios)
            lines.push(
              ...galleryMessageFrames(renderAgentMessageEntry, {
                ...entry,
                title: `${style} · ${entry.message.customType} · ${entry.title}`,
              }),
            );
          for (const background of BACKGROUNDS)
            withPresentationSettings({ toolCallBackground: background }, () => {
              const transcript = captureRegistrations((pi) => {
                registerSubagentTools(pi, runtime);
              }).tools;
              lines.push(
                ...galleryTranscriptFrames(
                  `${style} · ${background} · transcript: tool rows beside messages`,
                  transcriptEntries(transcript, scenarios),
                ),
              );
            });
        } finally {
          restore();
        }
      }
      lines.push(...activityLines(), ...widgetLines());
      yield* writeGallerySection(directory, "pi-subagents", lines);
    }),
  );
});
