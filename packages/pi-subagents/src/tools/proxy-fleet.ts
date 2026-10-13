import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "pi-cosmic-core";
import { invalidRequest, InvalidSubagentRequestError } from "../run/errors.ts";
import { MAX_PROTOCOL_ID_CHARS, MAX_RETAINED_RUNS } from "../run/limits.ts";
import {
  SUBAGENT_RUN_STATES,
  type SubagentControlExpectation,
  type SubagentRunView,
} from "../run/model.ts";
import { SubagentService } from "../run/service.ts";
import { omitReports, projectSubagentRunCard, type DetailDensity } from "./details-projection.ts";
import { NonEmptyText, SubagentRunCardSchema } from "./details-schema.ts";
import {
  decodeSubagentProxyRequest,
  encodeSubagentProxyInput,
  type SubagentProxyRequest,
} from "./proxy-protocol.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import type { SubagentToolInput } from "./schema.ts";

export const FLEET_SNAPSHOT_TOOL_NAME = "subagent_fleet_snapshot";
export const fleetSnapshotProxyRequest: SubagentProxyRequest = {
  tool: FLEET_SNAPSHOT_TOOL_NAME,
  argumentsJson: "{}",
};

const MAX_SNAPSHOT_CHARS = 1_900_000;
const FleetCardSchema = Schema.Struct({
  ...SubagentRunCardSchema.fields,
  assignmentEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
  question: Schema.optionalKey(
    Schema.Struct({
      requestId: NonEmptyText(MAX_PROTOCOL_ID_CHARS),
      message: NonEmptyText(2_048),
    }),
  ),
});
const FleetSnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal(FLEET_SNAPSHOT_TOOL_NAME),
  cards: Schema.Array(FleetCardSchema).check(Schema.isMaxLength(MAX_RETAINED_RUNS)),
});
const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Never)),
  {
    onExcessProperty: "error",
  },
);
const decodeSnapshot = Schema.decodeUnknownOption(FleetSnapshotSchema, {
  onExcessProperty: "error",
});

const projectFleetCard = (run: SubagentRunView, density: DetailDensity) => {
  const { question, ...card } = omitReports(projectSubagentRunCard(run, density));
  return {
    ...card,
    id: run.id,
    assignmentEpoch: run.assignmentEpoch,
    ...(run.parentRunId !== undefined && { parentRunId: run.parentRunId }),
    ...(run.sessionId !== undefined && { sessionId: run.sessionId }),
    ...(question &&
      run.question && {
        question: { ...question, requestId: run.question.requestId },
      }),
  };
};

export const decodeFleetSnapshotResult = (
  result: AgentToolResult<unknown>,
): ReadonlyArray<SubagentRunView> | undefined => {
  const decoded = decodeSnapshot(result.details);
  if (Option.isNone(decoded)) return undefined;
  const { cards } = decoded.value;
  if (
    result.isError ||
    JSON.stringify(decoded.value).length > MAX_SNAPSHOT_CHARS ||
    new Set(cards.map((card) => card.id)).size !== cards.length ||
    cards.some((card) => card.finalText !== undefined || card.error !== undefined)
  )
    return undefined;
  return freezeSnapshot(
    cards.map((card) =>
      Object.assign({}, card, {
        task: "Task details are shown in the root session",
        cwd: card.cwd ?? "",
        sessionEvents: [],
      }),
    ),
  );
};

export const executeFleetSnapshot = (request: SubagentProxyRequest, callerRunId: string) =>
  Effect.gen(function* () {
    if (
      request.tool !== FLEET_SNAPSHOT_TOOL_NAME ||
      request.argumentsJson.length > 128 ||
      Option.isNone(decodeArguments(request.argumentsJson))
    )
      return yield* invalidRequest(
        "proxy_request_invalid",
        "Fleet snapshot arguments are invalid.",
      );
    const service = yield* SubagentService;
    const runs = yield* service.visibleList(callerRunId);
    for (const density of ["compact", "minimal"] as const) {
      const result = {
        content: [],
        details: {
          version: 1,
          kind: FLEET_SNAPSHOT_TOOL_NAME,
          cards: runs.map((run) => projectFleetCard(run, density)),
        },
      };
      if (decodeFleetSnapshotResult(result) !== undefined) return result;
    }
    return yield* invalidRequest(
      "fleet_snapshot_unavailable",
      "The complete fleet snapshot could not be represented safely.",
    );
  });

export const FLEET_ACTION_TOOL_NAME = "subagent_fleet_action";
export type SubagentFleetActionInput = Extract<
  SubagentToolInput,
  {
    readonly tool: "subagent_send" | "subagent_reply" | "subagent_lifecycle" | "subagent_rename";
  }
>;
const MAX_FLEET_ACTION_CHARS = 2 * 1024 * 1024;
const FleetActionSchema = Schema.Struct({
  request: Schema.Struct({
    tool: NonEmptyText(64),
    argumentsJson: NonEmptyText(MAX_FLEET_ACTION_CHARS),
  }),
  expected: Schema.Struct({
    assignmentEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
    sessionId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
    state: Schema.Literals(SUBAGENT_RUN_STATES),
    questionRequestId: Schema.optionalKey(NonEmptyText(MAX_PROTOCOL_ID_CHARS)),
  }),
});
const decodeAction = Schema.decodeUnknownOption(Schema.fromJsonString(FleetActionSchema), {
  onExcessProperty: "error",
});
export const encodeFleetActionRequest = (
  input: SubagentFleetActionInput,
  expected: SubagentControlExpectation,
): SubagentProxyRequest => ({
  tool: FLEET_ACTION_TOOL_NAME,
  argumentsJson: JSON.stringify({ request: encodeSubagentProxyInput(input), expected }),
});
const invalidFleetAction = () =>
  invalidRequest("proxy_request_invalid", "Fleet action arguments are invalid.");
export const decodeFleetActionRequest = (
  request: SubagentProxyRequest,
):
  | { readonly input: SubagentFleetActionInput; readonly expected: SubagentControlExpectation }
  | InvalidSubagentRequestError => {
  if (
    request.tool !== FLEET_ACTION_TOOL_NAME ||
    request.argumentsJson.length > MAX_FLEET_ACTION_CHARS
  )
    return invalidFleetAction();
  const decoded = decodeAction(request.argumentsJson);
  if (Option.isNone(decoded)) return invalidFleetAction();
  const input = decodeSubagentProxyRequest(decoded.value.request);
  if (input instanceof InvalidSubagentRequestError) return input;
  switch (input.tool) {
    case SUBAGENT_TOOL_NAME.send:
      if (input.args.runIds.length !== 1) return invalidFleetAction();
      break;
    case SUBAGENT_TOOL_NAME.lifecycle:
      if (input.args.runIds.length !== 1 || input.args.action === "retry")
        return invalidFleetAction();
      break;
    case SUBAGENT_TOOL_NAME.reply:
    case SUBAGENT_TOOL_NAME.rename:
      break;
    case SUBAGENT_TOOL_NAME.await:
    case SUBAGENT_TOOL_NAME.claims:
    case SUBAGENT_TOOL_NAME.list:
    case SUBAGENT_TOOL_NAME.models:
    case SUBAGENT_TOOL_NAME.start:
    case SUBAGENT_TOOL_NAME.status:
    case SUBAGENT_TOOL_NAME.workspace:
      return invalidFleetAction();
  }
  return { input, expected: decoded.value.expected };
};
