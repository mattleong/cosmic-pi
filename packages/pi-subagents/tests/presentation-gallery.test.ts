import {
  applyPresentationSettings,
  captureRegistrations,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  type GalleryScenario,
} from "pi-code-previews/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeAwaitDetails, makeStartDetails } from "../src/tools/details.ts";
import { registerSubagentTools } from "../src/tools/subagent.ts";
import type { SubagentToolRuntime } from "../src/tools/execute.ts";
import { containedWriter, view } from "./fixtures/run-view.ts";

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

const awaited = (
  title: string,
  runs: Parameters<typeof makeAwaitDetails>[0]["runs"],
  extra: Partial<Parameters<typeof makeAwaitDetails>[0]> = {},
): GalleryScenario & { readonly tool: string } => ({
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

const scenarios: ReadonlyArray<GalleryScenario & { readonly tool: string }> = [
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
          createdAt: 1,
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
  awaited(
    "await timed out",
    [
      view({ state: "running" }),
      view({ id: "agent-2", name: "docs-sweep", state: "completed", finalText: "ok" }),
    ],
    { timedOut: true },
  ),
  awaited("writer changes ready for review", [
    view({
      state: "reported",
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
            warning: "Unsupported Herdr protocol 21. Fell back automatically to local/pi.",
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

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders subagent attention and outcomes in both collapsed styles", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const tools = captureRegistrations((pi) => registerSubagentTools(pi, runtime)).tools;
          for (const { tool, ...scenario } of scenarios)
            lines.push(
              ...galleryFrames(tools.find((entry) => entry.name === tool)!, {
                ...scenario,
                title: `${style} · ${scenario.title}`,
              }),
            );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-subagents", lines);
    }),
  );
});
