// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { withCodePreviewShell } from "pi-code-previews";
import type { HerdrError } from "../herd/errors.ts";
import { HerdrService } from "../herd/service.ts";
import type { HerdrAgentView, HerdrBatchFailure } from "../herd/model.ts";
import { formatFailure, formatHerdrAgents, formatHerdrReports } from "./format.ts";
import {
  HerdrAwaitParameters,
  HerdrListParameters,
  HerdrReadParameters,
  HerdrSendParameters,
  HerdrStartParameters,
  HerdrStatusParameters,
  HerdrStopParameters,
} from "./schema.ts";

export const HERDR_TOOL_NAMES = [
  "herdr_agent_start",
  "herdr_agent_list",
  "herdr_agent_status",
  "herdr_agent_await",
  "herdr_agent_read",
  "herdr_agent_send",
  "herdr_agent_stop",
] as const;

export interface HerdrToolDetails {
  readonly action: "start" | "list" | "status" | "await" | "read" | "send" | "stop";
  readonly agents?: ReadonlyArray<HerdrAgentView> | undefined;
  readonly failures?: ReadonlyArray<HerdrBatchFailure> | undefined;
  readonly source?: string | undefined;
}

export interface HerdrToolRuntime {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, HerdrService>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

const result = (content: string, details: HerdrToolDetails) => ({
  content: [{ type: "text" as const, text: content }],
  details,
});

const batch = <A>(
  items: ReadonlyArray<string>,
  operation: (id: string) => Effect.Effect<A, HerdrError>,
): Effect.Effect<{
  readonly values: ReadonlyArray<A>;
  readonly failures: ReadonlyArray<HerdrBatchFailure>;
}> =>
  Effect.gen(function* () {
    const values: A[] = [];
    const failures: HerdrBatchFailure[] = [];
    for (const id of new Set(items)) {
      const outcome = yield* Effect.exit(operation(id));
      if (Exit.isSuccess(outcome)) values.push(outcome.value);
      else {
        const causeFailure = Cause.findErrorOption(outcome.cause);
        const failure = formatFailure(
          Option.isSome(causeFailure) ? causeFailure.value : outcome.cause,
        );
        failures.push({ id, ...failure });
      }
    }
    return { values, failures };
  });

const withFailures = (content: string, failures: ReadonlyArray<HerdrBatchFailure>): string =>
  failures.length === 0
    ? content
    : `${content}${content ? "\n" : ""}${failures.map((failure) => `${failure.id} [${failure.code}] ${failure.message}`).join("\n")}`;

export function registerHerdrTools(pi: ExtensionAPI, runtime: HerdrToolRuntime): void {
  const start = defineTool({
    name: "herdr_agent_start",
    label: "Start Herdr Claude Agents",
    description:
      "Start one to twelve persistent read-only Claude Code agents in managed panes within the workspace's single pi-herdr tab. Every task must be self-contained. Agents survive Pi session replacement and cannot edit files or run shell commands.",
    promptSnippet: "Launch persistent read-only Claude Code agents through Herdr",
    promptGuidelines: [
      "Use herdr_agent_start only for independent read-only Claude Code research, review, or analysis. It cannot delegate implementation or project mutation.",
      "After starting Herdr agents, continue independent work and use herdr_agent_await once their reports become actionable; do not poll status repeatedly.",
      "Herdr agents persist beyond the Pi session. Stop them with herdr_agent_stop when their interactive Claude sessions are no longer needed.",
    ],
    parameters: HerdrStartParameters,
    async execute(_id, input, signal, onUpdate) {
      const output = await runtime.run(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const agents: HerdrAgentView[] = [];
          const failures: HerdrBatchFailure[] = [];
          for (let index = 0; index < input.agents.length; index += 1) {
            const requested = input.agents[index];
            if (!requested) continue;
            const outcome = yield* Effect.exit(service.start(requested));
            if (Exit.isSuccess(outcome)) agents.push(outcome.value);
            else {
              const causeFailure = Cause.findErrorOption(outcome.cause);
              const failure = formatFailure(
                Option.isSome(causeFailure) ? causeFailure.value : outcome.cause,
              );
              failures.push({ id: requested.name ?? `agents[${index}]`, ...failure });
            }
            onUpdate?.(
              result(withFailures(formatHerdrAgents(agents), failures), {
                action: "start",
                agents,
                failures,
              }),
            );
          }
          return { agents, failures };
        }),
        signal,
      );
      return result(withFailures(formatHerdrAgents(output.agents), output.failures), {
        action: "start",
        agents: output.agents,
        failures: output.failures,
      });
    },
    renderCall: (args, theme) =>
      new Text(
        `${theme.fg("toolTitle", theme.bold("herdr_agent_start"))} ${theme.fg("muted", `${args.agents.length} Claude agent${args.agents.length === 1 ? "" : "s"}`)}`,
        0,
        0,
      ),
    renderResult: (toolResult, { isPartial }, theme) =>
      new Text(
        theme.fg(
          isPartial ? "warning" : "toolOutput",
          toolResult.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        ),
        0,
        0,
      ),
  });

  const list = defineTool({
    name: "herdr_agent_list",
    label: "List Herdr Agents",
    description: "List extension-managed persistent Claude Code agents for the current project.",
    parameters: HerdrListParameters,
    async execute(_id, _input, signal) {
      const agents = await runtime.run(
        HerdrService.use((service) => service.list),
        signal,
      );
      return result(formatHerdrAgents(agents), { action: "list", agents });
    },
  });

  const status = defineTool({
    name: "herdr_agent_status",
    label: "Herdr Agent Status",
    description: "Inspect up to twelve extension-managed Herdr Claude agent runs.",
    parameters: HerdrStatusParameters,
    async execute(_id, input, signal) {
      const output = await runtime.run(
        HerdrService.use((service) => batch(input.runIds, service.status)),
        signal,
      );
      return result(withFailures(formatHerdrAgents(output.values), output.failures), {
        action: "status",
        agents: output.values,
        failures: output.failures,
      });
    },
  });

  const awaitTool = defineTool({
    name: "herdr_agent_await",
    label: "Await Herdr Agents",
    description:
      "Wait for selected Herdr Claude agents and collect their managed final reports. Returns early when a selected agent is blocked.",
    promptSnippet: "Wait for Herdr Claude agents and collect final reports",
    promptGuidelines: [
      "Use herdr_agent_await after independent work instead of polling herdr_agent_status. A blocked return requires inspection or guidance before awaiting again.",
    ],
    parameters: HerdrAwaitParameters,
    async execute(_id, input, signal, onUpdate) {
      const agents = await runtime.run(
        HerdrService.use((service) =>
          service.await(input.runIds, input.until, (progress) =>
            onUpdate?.(result(formatHerdrAgents(progress), { action: "await", agents: progress })),
          ),
        ),
        signal,
      );
      return result(formatHerdrReports(agents), { action: "await", agents });
    },
  });

  const read = defineTool({
    name: "herdr_agent_read",
    label: "Read Herdr Agent",
    description:
      "Read bounded terminal output from one managed Claude agent for diagnostics. Final task results should come from herdr_agent_await instead.",
    parameters: HerdrReadParameters,
    async execute(_id, input, signal) {
      const readResult = await runtime.run(
        HerdrService.use((service) =>
          service.read(input.runId, input.source ?? "recent-unwrapped", input.lines ?? 120),
        ),
        signal,
      );
      return result(readResult.text || "(no terminal output)", {
        action: "read",
        source: readResult.source,
      });
    },
  });

  const send = defineTool({
    name: "herdr_agent_send",
    label: "Send Herdr Guidance",
    description: "Send the same additional guidance to one or more active managed Claude agents.",
    parameters: HerdrSendParameters,
    async execute(_id, input, signal) {
      const output = await runtime.run(
        HerdrService.use((service) => batch(input.runIds, (id) => service.send(id, input.message))),
        signal,
      );
      return result(withFailures(formatHerdrAgents(output.values), output.failures), {
        action: "send",
        agents: output.values,
        failures: output.failures,
      });
    },
  });

  const stop = defineTool({
    name: "herdr_agent_stop",
    label: "Stop Herdr Agents",
    description:
      "Stop one or more extension-managed Claude agents and close only their owned panes. The shared managed tab remains available.",
    parameters: HerdrStopParameters,
    async execute(_id, input, signal) {
      const output = await runtime.run(
        HerdrService.use((service) => batch(input.runIds, service.stop)),
        signal,
      );
      return result(withFailures(formatHerdrAgents(output.values), output.failures), {
        action: "stop",
        agents: output.values,
        failures: output.failures,
      });
    },
  });

  for (const tool of [start, list, status, awaitTool, read, send, stop])
    pi.registerTool(withCodePreviewShell(tool));
}
