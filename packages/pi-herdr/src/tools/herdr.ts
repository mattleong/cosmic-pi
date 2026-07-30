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
import {
  formatFailure,
  formatHerdrAgentDetails,
  formatHerdrAgentList,
  formatHerdrAgents,
  formatHerdrReports,
  formatHerdrTerminalRead,
  withHerdrFailures,
} from "./format.ts";
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
  readonly runId?: string | undefined;
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

export function registerHerdrTools(pi: ExtensionAPI, runtime: HerdrToolRuntime): void {
  const start = defineTool({
    name: "herdr_agent_start",
    label: "Start Herdr Agents",
    description:
      "Start one to twelve persistent read-only Claude Code, Pi, or Codex agents in managed panes within the workspace's single pi-herdr tab. Every agent requires an explicit kind and native model. Tasks must be self-contained. Agents survive parent Pi session replacement and cannot edit project files.",
    promptSnippet: "Launch persistent read-only Claude, Pi, or Codex agents through Herdr",
    promptGuidelines: [
      "Use herdr_agent_start only for independent read-only research, review, or analysis. Every agent entry must explicitly select kind=claude|pi|codex and a native model; it cannot delegate implementation or project mutation.",
      "After starting Herdr agents, continue independent work and use herdr_agent_await once their reports become actionable; do not poll status repeatedly.",
      "Herdr agents persist beyond the parent Pi session. Stop them with herdr_agent_stop when their interactive panes are no longer needed.",
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
              failures.push({
                id: `#${index + 1}${requested.name ? ` ${requested.name}` : ""}`,
                ...failure,
              });
            }
            const progress = `Herdr start: ${agents.length} started · ${failures.length} failed · ${index + 1}/${input.agents.length} processed`;
            onUpdate?.(
              result(`${progress}\n${withHerdrFailures(formatHerdrAgents(agents), failures)}`, {
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
      return result(
        `Herdr start: ${output.agents.length} started · ${output.failures.length} failed\n${withHerdrFailures(formatHerdrAgents(output.agents), output.failures)}`,
        {
          action: "start",
          agents: output.agents,
          failures: output.failures,
        },
      );
    },
    renderCall: (args, theme) =>
      new Text(
        `${theme.fg("toolTitle", theme.bold("herdr_agent_start"))} ${theme.fg("muted", `${args.agents.length} agent${args.agents.length === 1 ? "" : "s"} · ${args.agents.map((agent) => agent.kind).join(", ")}`)}`,
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
    description:
      "List extension-managed persistent Claude Code, Pi, and Codex agents for the current project. Active and attention runs sort first; output is paginated at 25 rows by default.",
    parameters: HerdrListParameters,
    async execute(_id, input, signal) {
      const agents = await runtime.run(
        HerdrService.use((service) => service.list),
        signal,
      );
      return result(formatHerdrAgentList(agents, input.limit ?? 25, input.offset ?? 0), {
        action: "list",
        agents,
      });
    },
  });

  const status = defineTool({
    name: "herdr_agent_status",
    label: "Herdr Agent Status",
    description: "Inspect up to twelve extension-managed Herdr agent runs.",
    parameters: HerdrStatusParameters,
    async execute(_id, input, signal) {
      const output = await runtime.run(
        HerdrService.use((service) => batch(input.runIds, service.status)),
        signal,
      );
      const statuses =
        output.values.length > 0
          ? output.values.map(formatHerdrAgentDetails).join("\n\n")
          : output.failures.length > 0
            ? ""
            : "No matching Herdr agent statuses.";
      return result(withHerdrFailures(statuses, output.failures), {
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
      "Wait for selected Herdr agents and collect their managed final reports. Returns early when a selected agent is blocked.",
    promptSnippet: "Wait for Herdr agents and collect final reports",
    promptGuidelines: [
      "Use herdr_agent_await after independent work instead of polling herdr_agent_status. A blocked run without a report can receive guidance; a blocked final report cannot be resumed, so read it and start a new agent instead.",
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
      "Read bounded terminal output from one managed Herdr agent for diagnostics. Defaults to 120 recent unwrapped lines; the maximum is 500. Final task results should come from herdr_agent_await instead.",
    promptGuidelines: [
      "Use herdr_agent_read for diagnostics only. Completed task results should come from herdr_agent_await; reported terminal panes may already be closed.",
    ],
    parameters: HerdrReadParameters,
    async execute(_id, input, signal) {
      const source = input.source ?? "recent-unwrapped";
      const lines = input.lines ?? 120;
      const readResult = await runtime.run(
        HerdrService.use((service) =>
          Effect.gen(function* () {
            const agent = yield* service.status(input.runId);
            const paneClosed =
              agent.state === "stopped" ||
              (agent.report !== undefined &&
                (agent.state === "completed" || agent.state === "failed"));
            if (paneClosed) return { agent, source, text: undefined } as const;
            const terminal = yield* service.read(input.runId, source, lines);
            return { agent, source: terminal.source, text: terminal.text } as const;
          }),
        ),
        signal,
      );
      const content =
        readResult.text === undefined
          ? `${readResult.agent.name} (${input.runId}) no longer has an open managed pane. Use herdr_agent_await to read its final report.`
          : formatHerdrTerminalRead(input.runId, readResult.source, lines, readResult.text);
      return result(content, {
        action: "read",
        source: readResult.source,
        runId: input.runId,
      });
    },
  });

  const send = defineTool({
    name: "herdr_agent_send",
    label: "Send Herdr Guidance",
    description:
      "Send the same additional guidance to one or more active managed Herdr agents. Runs that already submitted a report reject guidance; start a new agent for follow-up work.",
    promptGuidelines: [
      "Send guidance only to unfinished runs without a report. A blocked final report cannot be resumed; read it and start a new agent instead.",
    ],
    parameters: HerdrSendParameters,
    async execute(_id, input, signal) {
      const output = await runtime.run(
        HerdrService.use((service) => batch(input.runIds, (id) => service.send(id, input.message))),
        signal,
      );
      const sent =
        output.values.length > 0
          ? `Guidance sent to ${output.values.length} agent${output.values.length === 1 ? "" : "s"}.\n${formatHerdrAgents(output.values)}`
          : "No guidance was sent.";
      return result(withHerdrFailures(sent, output.failures), {
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
      "Stop one or more extension-managed Claude, Pi, or Codex agents and close only their owned panes. The shared managed tab remains available.",
    promptGuidelines: [
      "Herdr agents survive Pi session replacement. Stop them when their interactive panes are no longer needed, especially after a blocked final report or a missing-report failure.",
    ],
    parameters: HerdrStopParameters,
    async execute(_id, input, signal) {
      const output = await runtime.run(
        HerdrService.use((service) => batch(input.runIds, service.stop)),
        signal,
      );
      const stopped =
        output.values.length > 0
          ? `Stopped ${output.values.length} agent${output.values.length === 1 ? "" : "s"}.\n${formatHerdrAgents(output.values)}`
          : "No agents were stopped.";
      return result(withHerdrFailures(stopped, output.failures), {
        action: "stop",
        agents: output.values,
        failures: output.failures,
      });
    },
  });

  for (const tool of [start, list, status, awaitTool, read, send, stop])
    pi.registerTool(withCodePreviewShell(tool));
}
