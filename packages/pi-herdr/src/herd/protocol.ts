import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HerdrCommandError, HerdrProtocolError } from "./errors.ts";
import type {
  HerdrCreatedTab,
  HerdrCreatedWorkspace,
  HerdrLayoutInfo,
  HerdrPaneInfo,
  HerdrRemoteAgentInfo,
  HerdrRemoteStatus,
  HerdrSnapshot,
  HerdrTabInfo,
  HerdrWorkspaceInfo,
} from "./model.ts";

const NullableString = Schema.NullOr(Schema.String);
const OptionalNullableString = Schema.optional(NullableString);
const AgentStatusSchema = Schema.String;

const WorktreeSchema = Schema.Struct({
  repo_root: OptionalNullableString,
  checkout_path: OptionalNullableString,
});

const WorkspaceSchema = Schema.Struct({
  workspace_id: Schema.String,
  label: Schema.String,
  focused: Schema.Boolean,
  active_tab_id: Schema.String,
  worktree: Schema.optional(Schema.NullOr(WorktreeSchema)),
});

const TabSchema = Schema.Struct({
  tab_id: Schema.String,
  workspace_id: Schema.String,
  label: Schema.String,
  pane_count: Schema.Number,
  focused: Schema.Boolean,
});

const PaneSchema = Schema.Struct({
  pane_id: Schema.String,
  terminal_id: Schema.String,
  workspace_id: Schema.String,
  tab_id: Schema.String,
  cwd: OptionalNullableString,
  foreground_cwd: OptionalNullableString,
  label: OptionalNullableString,
  focused: Schema.Boolean,
  agent_status: AgentStatusSchema,
});

const AgentSchema = Schema.Struct({
  pane_id: Schema.String,
  terminal_id: Schema.String,
  workspace_id: Schema.String,
  tab_id: Schema.String,
  cwd: OptionalNullableString,
  foreground_cwd: OptionalNullableString,
  focused: Schema.Boolean,
  agent_status: AgentStatusSchema,
  name: OptionalNullableString,
  agent: OptionalNullableString,
  state_change_seq: Schema.optional(Schema.Number),
  interactive_ready: Schema.optional(Schema.Boolean),
});

const LayoutSchema = Schema.Struct({
  workspace_id: Schema.String,
  tab_id: Schema.String,
  panes: Schema.Array(
    Schema.Struct({
      pane_id: Schema.String,
      rect: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
    }),
  ),
});

const SnapshotSchema = Schema.Struct({
  version: Schema.String,
  protocol: Schema.Number,
  focused_workspace_id: OptionalNullableString,
  focused_tab_id: OptionalNullableString,
  focused_pane_id: OptionalNullableString,
  workspaces: Schema.Array(WorkspaceSchema),
  tabs: Schema.Array(TabSchema),
  panes: Schema.Array(PaneSchema),
  agents: Schema.Array(AgentSchema),
  layouts: Schema.Array(LayoutSchema),
});

const ErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const ResultEnvelopeSchema = Schema.Struct({ result: Schema.Unknown });

const nonNull = <A>(value: A | null | undefined): A | undefined => value ?? undefined;

const agentStatus = (value: string): HerdrRemoteStatus =>
  value === "idle" || value === "working" || value === "blocked" || value === "done"
    ? value
    : "unknown";

const workspaceView = (value: Schema.Schema.Type<typeof WorkspaceSchema>): HerdrWorkspaceInfo => ({
  workspaceId: value.workspace_id,
  label: value.label,
  focused: value.focused,
  activeTabId: value.active_tab_id,
  ...(value.worktree
    ? {
        worktree: {
          ...(nonNull(value.worktree.repo_root)
            ? { repoRoot: nonNull(value.worktree.repo_root) }
            : {}),
          ...(nonNull(value.worktree.checkout_path)
            ? { checkoutPath: nonNull(value.worktree.checkout_path) }
            : {}),
        },
      }
    : {}),
});

const tabView = (value: Schema.Schema.Type<typeof TabSchema>): HerdrTabInfo => ({
  tabId: value.tab_id,
  workspaceId: value.workspace_id,
  label: value.label,
  paneCount: value.pane_count,
  focused: value.focused,
});

const paneView = (value: Schema.Schema.Type<typeof PaneSchema>): HerdrPaneInfo => ({
  paneId: value.pane_id,
  terminalId: value.terminal_id,
  workspaceId: value.workspace_id,
  tabId: value.tab_id,
  ...(nonNull(value.cwd) ? { cwd: nonNull(value.cwd) } : {}),
  ...(nonNull(value.foreground_cwd) ? { foregroundCwd: nonNull(value.foreground_cwd) } : {}),
  ...(nonNull(value.label) ? { label: nonNull(value.label) } : {}),
  focused: value.focused,
  agentStatus: agentStatus(value.agent_status),
});

const agentView = (value: Schema.Schema.Type<typeof AgentSchema>): HerdrRemoteAgentInfo => ({
  paneId: value.pane_id,
  terminalId: value.terminal_id,
  workspaceId: value.workspace_id,
  tabId: value.tab_id,
  ...(nonNull(value.cwd) ? { cwd: nonNull(value.cwd) } : {}),
  ...(nonNull(value.foreground_cwd) ? { foregroundCwd: nonNull(value.foreground_cwd) } : {}),
  focused: value.focused,
  agentStatus: agentStatus(value.agent_status),
  ...(nonNull(value.name) ? { name: nonNull(value.name) } : {}),
  ...(nonNull(value.agent) ? { agent: nonNull(value.agent) } : {}),
  stateChangeSeq: value.state_change_seq ?? 0,
  ...(value.interactive_ready === undefined ? {} : { interactiveReady: value.interactive_ready }),
});

const protocolFailure = (operation: string) =>
  new HerdrProtocolError({
    operation,
    code: "herdr_protocol_invalid",
    message: `Herdr returned an invalid response for ${operation}.`,
  });

export const decodeHerdrErrorOption = (
  operation: string,
  input: unknown,
): Option.Option<HerdrCommandError> => {
  const decoded = Schema.decodeUnknownOption(ErrorEnvelopeSchema)(input);
  return Option.isSome(decoded)
    ? Option.some(
        new HerdrCommandError({
          operation,
          code: decoded.value.error.code,
          message: decoded.value.error.message,
        }),
      )
    : Option.none();
};

export const decodeHerdrEnvelope = Effect.fn("HerdrProtocol.decodeEnvelope")(function* (
  operation: string,
  input: unknown,
) {
  const error = Schema.decodeUnknownOption(ErrorEnvelopeSchema)(input);
  if (Option.isSome(error))
    return yield* new HerdrCommandError({
      operation,
      code: error.value.error.code,
      message: error.value.error.message,
    });
  const envelope = yield* Schema.decodeUnknownEffect(ResultEnvelopeSchema)(input).pipe(
    Effect.mapError(() => protocolFailure(operation)),
  );
  return envelope.result;
});

export const decodeSnapshot = Effect.fn("HerdrProtocol.decodeSnapshot")(function* (input: unknown) {
  const result = yield* decodeHerdrEnvelope("session snapshot", input);
  const resultSchema = Schema.Struct({ snapshot: SnapshotSchema });
  const decoded = yield* Schema.decodeUnknownEffect(resultSchema)(result).pipe(
    Effect.mapError(() => protocolFailure("session snapshot")),
  );
  const snapshot = decoded.snapshot;
  return {
    version: snapshot.version,
    protocol: snapshot.protocol,
    ...(nonNull(snapshot.focused_workspace_id)
      ? { focusedWorkspaceId: nonNull(snapshot.focused_workspace_id) }
      : {}),
    ...(nonNull(snapshot.focused_tab_id) ? { focusedTabId: nonNull(snapshot.focused_tab_id) } : {}),
    ...(nonNull(snapshot.focused_pane_id)
      ? { focusedPaneId: nonNull(snapshot.focused_pane_id) }
      : {}),
    workspaces: snapshot.workspaces.map(workspaceView),
    tabs: snapshot.tabs.map(tabView),
    panes: snapshot.panes.map(paneView),
    agents: snapshot.agents.map(agentView),
    layouts: snapshot.layouts.map(
      (layout): HerdrLayoutInfo => ({
        workspaceId: layout.workspace_id,
        tabId: layout.tab_id,
        panes: layout.panes.map((pane) => ({
          paneId: pane.pane_id,
          width: pane.rect.width,
          height: pane.rect.height,
        })),
      }),
    ),
  } satisfies HerdrSnapshot;
});

export const decodeWorkspaceCreated = Effect.fn("HerdrProtocol.decodeWorkspaceCreated")(function* (
  input: unknown,
) {
  const result = yield* decodeHerdrEnvelope("create workspace", input);
  const schema = Schema.Struct({
    workspace: WorkspaceSchema,
    tab: TabSchema,
    root_pane: PaneSchema,
  });
  const decoded = yield* Schema.decodeUnknownEffect(schema)(result).pipe(
    Effect.mapError(() => protocolFailure("create workspace")),
  );
  return {
    workspace: workspaceView(decoded.workspace),
    tab: tabView(decoded.tab),
    rootPane: paneView(decoded.root_pane),
  } satisfies HerdrCreatedWorkspace;
});

export const decodeTabCreated = Effect.fn("HerdrProtocol.decodeTabCreated")(function* (
  input: unknown,
) {
  const result = yield* decodeHerdrEnvelope("create tab", input);
  const schema = Schema.Struct({ tab: TabSchema, root_pane: PaneSchema });
  const decoded = yield* Schema.decodeUnknownEffect(schema)(result).pipe(
    Effect.mapError(() => protocolFailure("create tab")),
  );
  return {
    tab: tabView(decoded.tab),
    rootPane: paneView(decoded.root_pane),
  } satisfies HerdrCreatedTab;
});

export const decodePane = Effect.fn("HerdrProtocol.decodePane")(function* (
  operation: string,
  input: unknown,
) {
  const result = yield* decodeHerdrEnvelope(operation, input);
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ pane: PaneSchema }))(
    result,
  ).pipe(Effect.mapError(() => protocolFailure(operation)));
  return paneView(decoded.pane);
});

export const decodeAgent = Effect.fn("HerdrProtocol.decodeAgent")(function* (
  operation: string,
  input: unknown,
) {
  const result = yield* decodeHerdrEnvelope(operation, input);
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ agent: AgentSchema }))(
    result,
  ).pipe(Effect.mapError(() => protocolFailure(operation)));
  return agentView(decoded.agent);
});

export const decodeAgents = Effect.fn("HerdrProtocol.decodeAgents")(function* (input: unknown) {
  const result = yield* decodeHerdrEnvelope("list agents", input);
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ agents: Schema.Array(AgentSchema) }),
  )(result).pipe(Effect.mapError(() => protocolFailure("list agents")));
  return decoded.agents.map(agentView);
});

export const decodeOk = Effect.fn("HerdrProtocol.decodeOk")(function* (
  operation: string,
  input: unknown,
) {
  yield* decodeHerdrEnvelope(operation, input);
});
