// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { withCodePreviewShell } from "pi-code-previews";
import { Type, type Static } from "typebox";
import { piToolsForWriteIntent } from "../run/coordination.ts";
import { InvalidSubagentRequestError, type SubagentError } from "../run/errors.ts";
import {
  isTerminalRunState,
  type StartSubagentRequest,
  type SubagentEffort,
  type SubagentModelView,
  type SubagentRunView,
} from "../run/model.ts";
import { synchronousNow } from "../boundary/native-clock.ts";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TARGET_RUNS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import {
  SubagentService,
  type SubagentAwaitUntil,
  type SubagentRunObservation,
} from "../run/service.ts";
import { MAX_TASK_CHARS, safeTextPrefix } from "../run/state.ts";
import { runStateColor, runStateGlyph } from "../ui/run-state.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../ui/sanitize.ts";
import { renderSubagentSessionOutput } from "./renderers/session-output.ts";

const ACTIONS = [
  "start",
  "list",
  "status",
  "await",
  "models",
  "send",
  "reply",
  "interrupt",
  "resume",
  "rename",
  "stop",
] as const;

const StartSpecParameters = Type.Object({
  task: Type.String({ description: "Task for this subagent.", maxLength: MAX_TASK_CHARS }),
  name: Type.Optional(Type.String({ description: "Optional display name." })),
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
  backend: StringEnum(["pi", "claude-cli"] as const, {
    description: "Execution backend.",
  }),
  writeIntent: StringEnum(["writer", "read-only"] as const, {
    description: "Only one shared-cwd writer may be active.",
  }),
  model: Type.Optional(
    Type.String({
      description:
        "Pi provider/model, or Claude alias/full ID. Pi inherits the parent; Claude defaults to sonnet.",
    }),
  ),
  effort: Type.Optional(
    StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
      description: "Thinking effort. Omit to inherit the parent effort.",
    }),
  ),
});

const SubagentToolParameters = Type.Object({
  action: StringEnum(ACTIONS),
  task: Type.Optional(
    Type.String({ description: "Task for a singular action=start.", maxLength: MAX_TASK_CHARS }),
  ),
  starts: Type.Optional(
    Type.Array(StartSpecParameters, {
      description: "Per-agent launch specifications for batch action=start.",
      minItems: 1,
      maxItems: MAX_TARGET_RUNS,
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Optional display name, or new name for rename." }),
  ),
  execution: StartSpecParameters.properties.execution,
  context: StartSpecParameters.properties.context,
  backend: Type.Optional(StartSpecParameters.properties.backend),
  writeIntent: Type.Optional(StartSpecParameters.properties.writeIntent),
  model: StartSpecParameters.properties.model,
  effort: StartSpecParameters.properties.effort,
  runId: Type.Optional(Type.String({ description: "Target run ID for management actions." })),
  runIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Target run IDs for await, batch status, or batch send.",
      minItems: 1,
      maxItems: 8,
    }),
  ),
  until: Type.Optional(
    StringEnum(["all_finished", "any_finished"] as const, {
      description:
        "Return when all selected runs are finished, or when any selected run is finished. Finished includes completed, failed, and stopped. Defaults to all_finished.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: "Optional await timeout; children continue running after timeout.",
      minimum: 1,
      maximum: 3600,
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Guidance, reply, or resume message.",
      maxLength: MAX_PARENT_MESSAGE_CHARS,
    }),
  ),
  query: Type.Optional(Type.String({ description: "Optional model search text." })),
});

export type SubagentStartSpec = Static<typeof StartSpecParameters>;
export type SubagentToolInput = Static<typeof SubagentToolParameters>;

export interface SubagentStartFailure {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
}

export interface SubagentToolDetails {
  readonly action: (typeof ACTIONS)[number];
  readonly runs?: ReadonlyArray<SubagentRunView>;
  readonly startFailures?: ReadonlyArray<SubagentStartFailure>;
  readonly models?: ReadonlyArray<SubagentModelView>;
  readonly awaitUntil?: SubagentAwaitUntil;
  readonly timedOut?: boolean;
}

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

const requiredTargetIds = (
  input: SubagentToolInput,
): Effect.Effect<ReadonlyArray<string>, InvalidSubagentRequestError> => {
  const ids = [
    ...(input.runId?.trim() ? [input.runId.trim()] : []),
    ...(input.runIds ?? []).map((id) => id.trim()).filter(Boolean),
  ];
  const unique = [...new Set(ids)];
  if (unique.length === 0)
    return Effect.fail(
      new InvalidSubagentRequestError({
        message: `action=${input.action} requires runId or runIds.`,
      }),
    );
  if (unique.length !== ids.length)
    return Effect.fail(
      new InvalidSubagentRequestError({ message: "Subagent target IDs must be unique." }),
    );
  if (unique.length > MAX_TARGET_RUNS)
    return Effect.fail(
      new InvalidSubagentRequestError({
        message: `Subagent actions accept at most ${MAX_TARGET_RUNS} targets.`,
      }),
    );
  return Effect.succeed(unique);
};

const batchStartSpecs = (
  input: SubagentToolInput,
): Effect.Effect<ReadonlyArray<SubagentStartSpec>, InvalidSubagentRequestError> => {
  if (!input.starts) return Effect.succeed([]);
  if (input.starts.length === 0 || input.starts.length > MAX_TARGET_RUNS)
    return Effect.fail(
      new InvalidSubagentRequestError({
        message: `Batch action=start requires between 1 and ${MAX_TARGET_RUNS} starts.`,
      }),
    );
  const hasSingularFields = [
    input.task,
    input.name,
    input.execution,
    input.context,
    input.backend,
    input.writeIntent,
    input.model,
    input.effort,
  ].some((value) => value !== undefined);
  return hasSingularFields
    ? Effect.fail(
        new InvalidSubagentRequestError({
          message: "Batch action=start cannot combine starts with singular start fields.",
        }),
      )
    : Effect.succeed(input.starts);
};

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

function resolvePiModel(
  input: SubagentToolInput | SubagentStartSpec,
  ctx: ExtensionContext,
): Effect.Effect<
  { readonly model: string; readonly runtimeApiKey?: string | undefined },
  InvalidSubagentRequestError
> {
  return Effect.gen(function* () {
    const requested = input.model?.trim();
    const inherited = ctx.model;
    const modelId = requested ?? (inherited ? `${inherited.provider}/${inherited.id}` : undefined);
    if (!modelId)
      return yield* new InvalidSubagentRequestError({
        message: "No parent model is active; specify model.",
      });
    const slash = modelId.indexOf("/");
    if (slash <= 0 || slash === modelId.length - 1)
      return yield* new InvalidSubagentRequestError({
        message: "model must use canonical provider/model form.",
      });
    const provider = modelId.slice(0, slash);
    const id = modelId.slice(slash + 1);
    const model = ctx.modelRegistry.find(provider, id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
      return yield* new InvalidSubagentRequestError({
        message: `Model is unavailable or unauthenticated: ${modelId}`,
      });
    if (ctx.modelRegistry.getProviderAuthStatus(model.provider).source !== "runtime")
      return { model: `${model.provider}/${model.id}` };
    const auth = yield* Effect.tryPromise({
      try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
      catch: () =>
        new InvalidSubagentRequestError({
          message: `Unable to resolve runtime authentication for ${modelId}.`,
        }),
    });
    if (!auth.ok || !auth.apiKey)
      return yield* new InvalidSubagentRequestError({
        message: `Runtime authentication is unavailable for ${modelId}.`,
      });
    return { model: `${model.provider}/${model.id}`, runtimeApiKey: auth.apiKey };
  });
}

function resolveStart(
  pi: ExtensionAPI,
  input: SubagentToolInput | SubagentStartSpec,
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
    if (!input.backend)
      return yield* new InvalidSubagentRequestError({
        message: "action=start requires backend=pi or claude-cli.",
      });
    const backend = input.backend;
    if (backend === "claude-cli" && !ctx.isProjectTrusted())
      return yield* new InvalidSubagentRequestError({
        message:
          "Claude CLI subagents require a trusted project because claude -p skips its trust dialog.",
      });
    if (backend === "claude-cli" && input.context === "fork")
      return yield* new InvalidSubagentRequestError({
        message: "Claude CLI does not support forked Pi context yet; use context=fresh.",
      });
    if (
      backend === "claude-cli" &&
      input.effort !== undefined &&
      (input.effort === "off" || input.effort === "minimal")
    )
      return yield* new InvalidSubagentRequestError({
        message: `Claude CLI does not support effort ${input.effort}.`,
      });
    const resolved =
      backend === "pi"
        ? yield* resolvePiModel(input, ctx)
        : { model: input.model?.trim() || "sonnet" };
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
      backend,
      task,
      cwd: ctx.cwd,
      execution: input.execution ?? "background",
      context: input.context ?? "fresh",
      writeIntent: input.writeIntent,
      model: resolved.model,
      ...(resolved.runtimeApiKey ? { runtimeApiKey: resolved.runtimeApiKey } : {}),
      effort:
        input.effort ??
        (backend === "claude-cli" && ["off", "minimal"].includes(pi.getThinkingLevel())
          ? "low"
          : (pi.getThinkingLevel() as SubagentEffort)),
      effortWasExplicit: input.effort !== undefined,
      activeTools:
        backend === "pi"
          ? piToolsForWriteIntent(
              pi.getActiveTools().filter((name) => !blocked.has(name)),
              input.writeIntent,
            )
          : [],
      projectTrusted: ctx.isProjectTrusted(),
      parentSessionId: ctx.sessionManager.getSessionId(),
      ...(parentSessionFile ? { parentSessionFile } : {}),
      ...(parentLeafId ? { parentLeafId } : {}),
    } satisfies StartSubagentRequest;
  });
}

const formatRun = (run: SubagentRunView, detailed = false): string => {
  const header = `${run.id} ${run.name} · ${run.state} · ${run.writeIntent} · ${run.backend}/${run.model}:${run.effort}`;
  if (!detailed) return header;
  const field = (label: string, value: string): string => `  ${label.padEnd(10)} ${value}`;
  return [
    "Subagent status",
    field("Name", run.name),
    field("ID", run.id),
    field("State", run.state),
    field("Model", `${run.backend}/${run.model} · ${run.effort}`),
    field("Mode", `${run.execution} · ${run.context}`),
    field("Intent", run.writeIntent),
    run.pid ? field("Process", `pid ${run.pid}`) : undefined,
    field("Usage", `${run.usage.totalTokens} tokens · $${run.usage.cost.toFixed(4)}`),
    run.currentTool ? field("Tool", run.currentTool) : undefined,
    run.progress ? field("Progress", run.progress) : undefined,
    run.warning ? field("Warning", run.warning) : undefined,
    run.question ? field("Question", run.question.message) : undefined,
    run.error ? field("Error", run.error) : undefined,
    run.finalText
      ? `\nFinal report\n${run.finalText}`
      : run.state === "completed"
        ? "\nFinal report\nCompleted without a final report."
        : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

interface DetailedRunsFormat {
  readonly text: string;
  readonly fullyRenderedIds: ReadonlySet<string>;
}

const formatDetailedRuns = (
  runs: ReadonlyArray<SubagentRunView>,
  prefix = "",
): DetailedRunsFormat => {
  if (runs.length === 0)
    return { text: prefix || "No subagent runs.", fullyRenderedIds: new Set() };
  const separatorLength = Math.max(0, runs.length - 1) * 2;
  const available = Math.max(0, MAX_TOOL_OUTPUT_CHARS - prefix.length - separatorLength);
  const perRun = Math.max(256, Math.floor(available / runs.length));
  const fullyRenderedIds = new Set<string>();
  const formatted = runs.map((run) => {
    const value = formatRun(run, true);
    if (value.length <= perRun) {
      fullyRenderedIds.add(run.id);
      return value;
    }
    const marker = "\n… [run output truncated]";
    return `${safeTextPrefix(value, Math.max(0, perRun - marker.length))}${marker}`;
  });
  const output = `${prefix}${formatted.join("\n\n")}`;
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return { text: output, fullyRenderedIds };
  return {
    text: `${safeTextPrefix(output, MAX_TOOL_OUTPUT_CHARS - 1)}…`,
    fullyRenderedIds: new Set(),
  };
};

const formatStartFailures = (failures: ReadonlyArray<SubagentStartFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed starts (${failures.length})`,
        ...failures.map((failure) => {
          const target = failure.name ? ` ${sanitizeTerminalLine(failure.name)}` : "";
          const message = safeTextPrefix(sanitizeTerminalLine(failure.message), 320);
          return `  #${failure.index + 1}${target}: ${message}`;
        }),
      ].join("\n");

const formatStartResult = (
  runs: ReadonlyArray<SubagentRunView>,
  failures: ReadonlyArray<SubagentStartFailure>,
): string => {
  const failureText = formatStartFailures(failures);
  return formatDetailedRuns(
    runs,
    failureText ? `${failureText}${runs.length > 0 ? "\n\n" : ""}` : "",
  ).text;
};

const renderedCompletionReceipts = (
  observations: ReadonlyArray<SubagentRunObservation>,
  fullyRenderedIds: ReadonlySet<string>,
) =>
  observations.flatMap((observation) =>
    observation.completionReceipt && fullyRenderedIds.has(observation.run.id)
      ? [observation.completionReceipt]
      : [],
  );

function availableModels(
  input: SubagentToolInput,
  ctx: ExtensionContext,
): ReadonlyArray<SubagentModelView> {
  const query = input.query?.trim().toLowerCase();
  const piModels: ReadonlyArray<SubagentModelView> = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({
      backend: "pi" as const,
      id: `${model.provider}/${model.id}`,
      name: model.name,
      reasoning: model.reasoning,
    }));
  const claudeModels: ReadonlyArray<SubagentModelView> = [
    { backend: "claude-cli", id: "sonnet", name: "Claude Sonnet", reasoning: true },
    { backend: "claude-cli", id: "opus", name: "Claude Opus", reasoning: true },
    { backend: "claude-cli", id: "haiku", name: "Claude Haiku", reasoning: true },
  ];
  return [
    ...(input.backend === "claude-cli" ? [] : piModels),
    ...(input.backend === "pi" ? [] : claudeModels),
  ]
    .filter(
      (model) =>
        !query || `${model.backend} ${model.id} ${model.name}`.toLowerCase().includes(query),
    )
    .slice(0, 100);
}

const awaitProgressHeader = (
  runs: ReadonlyArray<SubagentRunView>,
  until: SubagentAwaitUntil,
): string => {
  const finished = runs.filter((run) => isTerminalRunState(run.state)).length;
  return `Awaiting subagents · ${finished}/${runs.length} finished · ${until}`;
};

const awaitRunStatus = (run: SubagentRunView): string =>
  sanitizeTerminalLine(`${run.state}${run.currentTool ? ` (${run.currentTool})` : ""}`);

const formatAwaitProgress = (
  runs: ReadonlyArray<SubagentRunView>,
  until: SubagentAwaitUntil,
): string =>
  [
    awaitProgressHeader(runs, until),
    ...runs.map(
      (run) =>
        `${runStateGlyph(run.state)} ${sanitizeTerminalLine(run.name)} (${sanitizeTerminalLine(run.id)}) · ${awaitRunStatus(run)}`,
    ),
  ].join("\n");

export const renderAwaitProgress = (
  runs: ReadonlyArray<SubagentRunView>,
  until: SubagentAwaitUntil,
  theme: Theme,
): string =>
  [
    theme.fg("warning", awaitProgressHeader(runs, until)),
    ...runs.map((run) => {
      const name = sanitizeTerminalLine(run.name);
      const id = sanitizeTerminalLine(run.id);
      return `${theme.fg(runStateColor(run.state), `${runStateGlyph(run.state)} ${name}`)} ${theme.fg("dim", `(${id})`)} · ${theme.fg("toolOutput", awaitRunStatus(run))}`;
    }),
  ].join("\n");

const managementAcknowledgement = (
  action: SubagentToolInput["action"],
  runs: ReadonlyArray<SubagentRunView>,
): string => {
  const ids = runs.map((run) => run.id).join(", ");
  switch (action) {
    case "send":
      return `Guidance delivered to ${runs.length} subagent${runs.length === 1 ? "" : "s"}: ${ids}.`;
    case "reply":
      return `Reply delivered to ${ids}.`;
    case "interrupt":
      return `Paused ${ids}.`;
    case "resume":
      return `Resumed ${ids}.`;
    case "rename":
      return `Renamed ${ids}.`;
    case "stop":
      return `Stopped ${ids}.`;
    default:
      return runs.map((run) => formatRun(run, true)).join("\n\n");
  }
};

export function registerSubagentTool(pi: ExtensionAPI, runtime: SubagentToolRuntime): void {
  const tool = defineTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Start one or up to eight session-scoped subagents per call and manage foreground or background runs. Use await to collect background results without polling.",
    promptSnippet:
      "Start and manage named foreground/background subagents, including per-agent batch launches, with explicit model, effort, context, and write intent",
    promptGuidelines: [
      "Use subagent for delegated work that can proceed independently; background is the default launch mode.",
      "For parallel launch, action=start accepts a starts array of up to eight per-agent specifications; successful launches remain active if another item fails.",
      "Every subagent start must explicitly declare writeIntent as writer or read-only.",
      "Keep only one writer in the shared cwd, counting the main agent itself; do not edit while a writer subagent is active.",
      "Parallelize read-only research, inspection, and review; serialize writes unless isolated worktrees are introduced later.",
      "Do not poll subagent status. After independent work, call subagent await once to collect background results; use status only for troubleshooting or a user-requested snapshot.",
      "Subagent interrupt pauses work and must never be used merely to inspect progress. Use send to steer a running child and reply when a child is waiting for the parent.",
    ],
    parameters: SubagentToolParameters,
    async execute(_toolCallId, input, signal, onUpdate, ctx) {
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
                          `${model.backend}/${model.id} · ${model.reasoning ? "reasoning" : "no reasoning"}`,
                      )
                      .join("\n")
                  : "No matching models.",
            },
          ],
          details: { action: input.action, models } satisfies SubagentToolDetails,
        };
      }

      const effect = Effect.gen(function* () {
        const service = yield* SubagentService;
        const observeStatus = (id: string) =>
          service.observeStatus
            ? service.observeStatus(id)
            : service.status(id).pipe(Effect.map((run) => ({ run })));
        const consumeCompletions = (
          observations: ReadonlyArray<SubagentRunObservation>,
          fullyRenderedIds: ReadonlySet<string>,
        ) =>
          service.consumeCompletions
            ? service.consumeCompletions(renderedCompletionReceipts(observations, fullyRenderedIds))
            : Effect.void;
        const finishObservations = (
          observations: ReadonlyArray<SubagentRunObservation>,
          timedOut: boolean,
        ) =>
          Effect.gen(function* () {
            const runs = observations.map((observation) => observation.run);
            const formatted = formatDetailedRuns(
              runs,
              timedOut ? "Await timed out; subagents continue running.\n\n" : "",
            );
            yield* consumeCompletions(observations, formatted.fullyRenderedIds);
            return { runs, timedOut, text: formatted.text };
          });
        const finishStatus = (ids: ReadonlyArray<string>, timedOut: boolean) =>
          service.withStatusObservations
            ? service.withStatusObservations(ids, (observations) =>
                finishObservations(observations, timedOut),
              )
            : Effect.forEach(ids, observeStatus, { concurrency: 8 }).pipe(
                Effect.flatMap((observations) => finishObservations(observations, timedOut)),
              );
        switch (input.action) {
          case "start": {
            const specs = yield* batchStartSpecs(input);
            const startOne = (startInput: SubagentToolInput | SubagentStartSpec) =>
              Effect.gen(function* () {
                const request = yield* resolveStart(pi, startInput, ctx);
                const started = yield* service.start(request);
                return request.execution === "foreground"
                  ? yield* service.waitForForeground(started.id)
                  : started;
              });
            if (specs.length === 0) return { runs: [yield* startOne(input)], timedOut: false };
            const outcomes = yield* Effect.forEach(
              specs,
              (spec, index) =>
                startOne(spec).pipe(
                  Effect.match({
                    onFailure: (error) => ({
                      failure: {
                        index,
                        ...(spec.name?.trim() ? { name: spec.name.trim() } : {}),
                        message: error.message,
                      } satisfies SubagentStartFailure,
                    }),
                    onSuccess: (run) => ({ run }),
                  }),
                ),
              { concurrency: MAX_TARGET_RUNS },
            );
            return {
              runs: outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
              startFailures: outcomes.flatMap((outcome) =>
                "failure" in outcome ? [outcome.failure] : [],
              ),
              timedOut: false,
            };
          }
          case "list":
            return { runs: yield* service.list, timedOut: false };
          case "status":
            return yield* finishStatus(yield* requiredTargetIds(input), false);
          case "await": {
            const ids = yield* requiredTargetIds(input);
            const until = input.until ?? "all_finished";
            let lastUpdate = "";
            const updateAwait = (runs: ReadonlyArray<SubagentRunView>) => {
              const text = formatAwaitProgress(runs, until);
              if (text === lastUpdate) return;
              lastUpdate = text;
              onUpdate?.({
                content: [{ type: "text", text }],
                details: {
                  action: "await",
                  runs,
                  awaitUntil: until,
                } satisfies SubagentToolDetails,
              });
            };
            let waiting: Effect.Effect<
              {
                readonly runs: ReadonlyArray<SubagentRunView>;
                readonly timedOut: boolean;
                readonly text: string;
              },
              SubagentError
            >;
            if (service.withAwaitTerminalObservations)
              waiting = service.withAwaitTerminalObservations(
                ids,
                until,
                updateAwait,
                (observations) => finishObservations(observations, false),
              );
            else {
              const observed: Effect.Effect<
                ReadonlyArray<SubagentRunObservation>,
                SubagentError
              > = service.awaitTerminalObserved
                ? service.awaitTerminalObserved(ids, until, updateAwait)
                : service
                    .awaitTerminal(ids, until, updateAwait)
                    .pipe(Effect.map((runs) => runs.map((run) => ({ run }))));
              waiting = observed.pipe(
                Effect.flatMap((observations) => finishObservations(observations, false)),
              );
            }
            if (input.timeoutSeconds === undefined) return yield* waiting;
            const outcome = yield* waiting.pipe(
              Effect.timeoutOption(`${input.timeoutSeconds} seconds`),
            );
            if (Option.isSome(outcome)) return outcome.value;
            return yield* finishStatus(ids, true);
          }
          case "send": {
            const ids = yield* requiredTargetIds(input);
            const message = yield* requiredMessage(input);
            const runs = yield* Effect.forEach(ids, (id) => service.send(id, message), {
              concurrency: 8,
            });
            return { runs, timedOut: false };
          }
          case "reply":
            return {
              runs: [
                yield* service.reply(yield* requiredRunId(input), yield* requiredMessage(input)),
              ],
              timedOut: false,
            };
          case "interrupt":
            return {
              runs: [yield* service.interrupt(yield* requiredRunId(input))],
              timedOut: false,
            };
          case "resume":
            return {
              runs: [yield* service.resume(yield* requiredRunId(input), input.message)],
              timedOut: false,
            };
          case "rename":
            return {
              runs: [yield* service.rename(yield* requiredRunId(input), input.name?.trim() ?? "")],
              timedOut: false,
            };
          case "stop":
            return {
              runs: [yield* service.stop(yield* requiredRunId(input))],
              timedOut: false,
            };
          case "models":
            return { runs: [], timedOut: false };
        }
      });
      const executionResult: {
        readonly runs: ReadonlyArray<SubagentRunView>;
        readonly startFailures?: ReadonlyArray<SubagentStartFailure>;
        readonly timedOut: boolean;
        readonly text?: string;
      } = await runtime.run(effect, signal);
      const { runs, timedOut, text: formattedText } = executionResult;
      const startFailures = executionResult.startFailures ?? [];
      const details: SubagentToolDetails =
        input.action === "start"
          ? {
              action: input.action,
              runs,
              ...(startFailures.length > 0 ? { startFailures } : {}),
            }
          : { action: input.action, ...(timedOut ? { timedOut: true } : {}) };
      const text =
        input.action === "start"
          ? formatStartResult(runs, startFailures)
          : runs.length === 0
            ? "No subagent runs."
            : input.action === "list"
              ? runs.map((run) => formatRun(run)).join("\n")
              : input.action === "status" || input.action === "await"
                ? (formattedText ?? formatDetailedRuns(runs).text)
                : managementAcknowledgement(input.action, runs);
      return {
        content: [{ type: "text", text }],
        details,
      };
    },
    renderCall(args, theme) {
      const action = args.action ?? "...";
      const target = sanitizeTerminalLine(
        args.starts?.map((spec) => spec.name ?? spec.task).join(", ") ??
          args.runIds?.join(",") ??
          args.runId ??
          args.name ??
          args.task ??
          args.query ??
          args.message ??
          "",
      );
      const clippedTarget = safeTextPrefix(target, 160);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", action)}${clippedTarget ? ` ${theme.fg("dim", clippedTarget)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const details = result.details as SubagentToolDetails | undefined;
      if (isPartial && details?.action === "await" && details.runs && details.awaitUntil)
        return new Text(renderAwaitProgress(details.runs, details.awaitUntil, theme), 0, 0);
      if (
        expanded &&
        !isPartial &&
        details?.action === "start" &&
        details.runs?.length === 1 &&
        !details.startFailures?.length
      ) {
        const run = details.runs[0];
        if (run) return renderSubagentSessionOutput(run, theme, { now: synchronousNow() });
      }
      let text = sanitizeTerminalText(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
      if (!expanded) {
        const lines = text.split("\n");
        if (lines.length > 12) text = `${lines.slice(0, 12).join("\n")}\n…`;
      }
      return new Text(
        theme.fg(isPartial ? "warning" : "toolOutput", text || (isPartial ? "Working…" : "Done")),
        0,
        0,
      );
    },
  });
  pi.registerTool(withCodePreviewShell(tool));
}
