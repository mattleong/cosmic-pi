// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { Type, type Static } from "typebox";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import type {
  StartSubagentRequest,
  SubagentEffort,
  SubagentModelView,
  SubagentRunView,
} from "../run/model.ts";
import { SubagentService } from "../run/service.ts";

const SubagentToolParameters = Type.Object({
  action: StringEnum([
    "start",
    "list",
    "status",
    "models",
    "send",
    "reply",
    "interrupt",
    "resume",
    "rename",
    "stop",
  ] as const),
  task: Type.Optional(Type.String({ description: "Task for action=start." })),
  name: Type.Optional(
    Type.String({ description: "Optional display name, or new name for rename." }),
  ),
  execution: Type.Optional(
    StringEnum(["foreground", "background"] as const, {
      description: "Launch behavior; defaults to background.",
    }),
  ),
  context: Type.Optional(
    StringEnum(["fresh", "fork"] as const, {
      description: "Child context; defaults to fresh.",
    }),
  ),
  writeIntent: Type.Optional(
    StringEnum(["writer", "read-only"] as const, {
      description: "Required for start. Only one shared-cwd writer may be active.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Canonical provider/model. Omit to inherit the parent model." }),
  ),
  effort: Type.Optional(
    StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
      description: "Thinking effort. Omit to inherit the parent effort.",
    }),
  ),
  runId: Type.Optional(Type.String({ description: "Target run ID for management actions." })),
  message: Type.Optional(Type.String({ description: "Guidance, reply, or resume message." })),
  query: Type.Optional(Type.String({ description: "Optional model search text." })),
});

export type SubagentToolInput = Static<typeof SubagentToolParameters>;

export interface SubagentToolRuntime {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SubagentService>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

const requiredRunId = (
  input: SubagentToolInput,
): Effect.Effect<string, InvalidSubagentRequestError> =>
  input.runId?.trim()
    ? Effect.succeed(input.runId.trim())
    : Effect.fail(
        new InvalidSubagentRequestError({ message: `action=${input.action} requires runId.` }),
      );

const requiredMessage = (
  input: SubagentToolInput,
): Effect.Effect<string, InvalidSubagentRequestError> =>
  input.message?.trim()
    ? Effect.succeed(input.message.trim())
    : Effect.fail(
        new InvalidSubagentRequestError({ message: `action=${input.action} requires message.` }),
      );

function stableParentLeaf(ctx: ExtensionContext): string | undefined {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!leaf) return undefined;
  if (leaf.type === "message" && leaf.message.role === "assistant")
    return leaf.parentId ?? undefined;
  return leaf.id;
}

function resolveModel(
  input: SubagentToolInput,
  ctx: ExtensionContext,
): Effect.Effect<{ readonly model: string }, InvalidSubagentRequestError> {
  const requested = input.model?.trim();
  const inherited = ctx.model;
  const modelId = requested ?? (inherited ? `${inherited.provider}/${inherited.id}` : undefined);
  if (!modelId)
    return Effect.fail(
      new InvalidSubagentRequestError({ message: "No parent model is active; specify model." }),
    );
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1)
    return Effect.fail(
      new InvalidSubagentRequestError({ message: "model must use canonical provider/model form." }),
    );
  const provider = modelId.slice(0, slash);
  const id = modelId.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, id);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
    return Effect.fail(
      new InvalidSubagentRequestError({
        message: `Model is unavailable or unauthenticated: ${modelId}`,
      }),
    );
  return Effect.succeed({ model: `${model.provider}/${model.id}` });
}

function resolveStart(
  pi: ExtensionAPI,
  input: SubagentToolInput,
  ctx: ExtensionContext,
): Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError> {
  return Effect.gen(function* () {
    const task = input.task?.trim();
    if (!task)
      return yield* new InvalidSubagentRequestError({ message: "action=start requires task." });
    if (!input.writeIntent)
      return yield* new InvalidSubagentRequestError({
        message: "action=start requires writeIntent=writer or read-only.",
      });
    const resolved = yield* resolveModel(input, ctx);
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const parentLeafId = stableParentLeaf(ctx);
    if (input.context === "fork" && (!parentSessionFile || !parentLeafId))
      return yield* new InvalidSubagentRequestError({
        message: "Forked context requires a persisted parent session with a stable leaf.",
      });
    const blocked = new Set([
      "subagent",
      "subagent_wait",
      "subagent_supervisor",
      "workflow",
      "workflow_control",
    ]);
    return {
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      task,
      cwd: ctx.cwd,
      execution: input.execution ?? "background",
      context: input.context ?? "fresh",
      writeIntent: input.writeIntent,
      model: resolved.model,
      effort: input.effort ?? (pi.getThinkingLevel() as SubagentEffort),
      effortWasExplicit: input.effort !== undefined,
      activeTools: pi.getActiveTools().filter((name) => !blocked.has(name)),
      projectTrusted: ctx.isProjectTrusted(),
      parentSessionId: ctx.sessionManager.getSessionId(),
      ...(parentSessionFile ? { parentSessionFile } : {}),
      ...(parentLeafId ? { parentLeafId } : {}),
    } satisfies StartSubagentRequest;
  });
}

const formatRun = (run: SubagentRunView, detailed = false): string => {
  const header = `${run.id} ${run.name} · ${run.state} · ${run.writeIntent} · ${run.model}:${run.effort}`;
  if (!detailed) return header;
  const formatted = [
    header,
    `context=${run.context} execution=${run.execution}${run.pid ? ` pid=${run.pid}` : ""}`,
    run.sessionFile ? `session=${run.sessionFile}` : undefined,
    run.currentTool ? `tool=${run.currentTool}` : undefined,
    run.progress ? `progress=${run.progress}` : undefined,
    run.warning ? `warning=${run.warning}` : undefined,
    run.question ? `question=${run.question.message}` : undefined,
    run.error ? `error=${run.error}` : undefined,
    `usage=${run.usage.totalTokens} tokens · $${run.usage.cost.toFixed(4)}`,
    run.finalText ? `\n${run.finalText}` : undefined,
    run.transcript.length
      ? `\nRecent transcript:\n${run.transcript.slice(-30).join("\n")}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return formatted.length <= 45_000 ? formatted : `${formatted.slice(0, 45_000)}…`;
};

function availableModels(
  input: SubagentToolInput,
  ctx: ExtensionContext,
): ReadonlyArray<SubagentModelView> {
  const query = input.query?.trim().toLowerCase();
  return ctx.modelRegistry
    .getAvailable()
    .map((model) => ({
      id: `${model.provider}/${model.id}`,
      name: model.name,
      reasoning: model.reasoning,
    }))
    .filter((model) => !query || `${model.id} ${model.name}`.toLowerCase().includes(query))
    .slice(0, 100);
}

export function registerSubagentTool(pi: ExtensionAPI, runtime: SubagentToolRuntime): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Start and manage session-scoped foreground or background subagents. Output is bounded; inspect status for current progress and transcript.",
    promptSnippet:
      "Start and manage named foreground/background subagents with explicit model, effort, context, and write intent",
    promptGuidelines: [
      "Use subagent for delegated work that can proceed independently; background is the default launch mode.",
      "Every subagent start must explicitly declare writeIntent as writer or read-only.",
      "Keep only one writer in the shared cwd, counting the main agent itself; do not edit while a writer subagent is active.",
      "Parallelize read-only research, inspection, and review; serialize writes unless isolated worktrees are introduced later.",
      "Use subagent status before assigning new write work, and use reply when a child is waiting for the parent.",
    ],
    parameters: SubagentToolParameters,
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      if (input.action === "models") {
        const models = availableModels(input, ctx);
        return {
          content: [
            {
              type: "text",
              text:
                models.length > 0
                  ? models
                      .map(
                        (model) =>
                          `${model.id} · ${model.reasoning ? "reasoning" : "no reasoning"}`,
                      )
                      .join("\n")
                  : "No matching authenticated models.",
            },
          ],
          details: { models },
        };
      }

      const effect = Effect.gen(function* () {
        const service = yield* SubagentService;
        switch (input.action) {
          case "start": {
            const request = yield* resolveStart(pi, input, ctx);
            const started = yield* service.start(request);
            return request.execution === "foreground"
              ? yield* service.waitForForeground(started.id)
              : started;
          }
          case "list":
            return yield* service.list;
          case "status":
            return yield* service.status(yield* requiredRunId(input));
          case "send":
            return yield* service.send(yield* requiredRunId(input), yield* requiredMessage(input));
          case "reply":
            return yield* service.reply(yield* requiredRunId(input), yield* requiredMessage(input));
          case "interrupt":
            return yield* service.interrupt(yield* requiredRunId(input));
          case "resume":
            return yield* service.resume(yield* requiredRunId(input), input.message);
          case "rename":
            return yield* service.rename(yield* requiredRunId(input), input.name?.trim() ?? "");
          case "stop":
            return yield* service.stop(yield* requiredRunId(input));
          case "models":
            return [];
        }
      });
      const result = await runtime.run(effect, signal);
      const runs = Array.isArray(result) ? result : [result];
      return {
        content: [
          {
            type: "text",
            text:
              runs.length > 0
                ? runs.map((run) => formatRun(run, input.action !== "list")).join("\n\n")
                : "No subagent runs.",
          },
        ],
        details: { action: input.action, runs },
      };
    },
  });
}
