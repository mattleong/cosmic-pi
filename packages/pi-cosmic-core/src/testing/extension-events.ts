import type {
  AgentBeforeSettleEventResult,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEventResult,
  CacheWarmingDecisionEventResult,
  ContextEventResult,
  ExtensionContext,
  ExtensionEvent,
  InputEventResult,
  MessageEndEventResult,
  ProjectTrustEventResult,
  ResourcesDiscoverResult,
  SessionBeforeCompactResult,
  SessionBeforeForkResult,
  SessionBeforeSwitchResult,
  SessionBeforeTreeResult,
  ToolCallEventResult,
  ToolResultEventResult,
  TurnEndEventResult,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

export type ExtensionEventName = ExtensionEvent["type"];
export type ExtensionEventNamed<Name extends ExtensionEventName> = string extends Name
  ? never
  : Extract<ExtensionEvent, { readonly type: Name }>;

interface ExtensionEventResults {
  readonly project_trust: ProjectTrustEventResult;
  readonly resources_discover: ResourcesDiscoverResult;
  readonly session_before_switch: SessionBeforeSwitchResult;
  readonly session_before_fork: SessionBeforeForkResult;
  readonly session_before_compact: SessionBeforeCompactResult;
  readonly session_before_tree: SessionBeforeTreeResult;
  readonly context: ContextEventResult;
  readonly context_with_system: ContextEventResult;
  readonly cache_warming_decision: CacheWarmingDecisionEventResult;
  readonly before_provider_request: BeforeProviderRequestEventResult;
  readonly before_agent_start: BeforeAgentStartEventResult;
  readonly agent_before_settle: AgentBeforeSettleEventResult;
  readonly turn_end: TurnEndEventResult;
  readonly message_end: MessageEndEventResult;
  readonly tool_call: ToolCallEventResult;
  readonly tool_result: ToolResultEventResult;
  readonly user_bash: UserBashEventResult;
  readonly input: InputEventResult;
}

export type ExtensionEventResult<Name extends ExtensionEventName> =
  Name extends keyof ExtensionEventResults ? ExtensionEventResults[Name] : undefined;

export type RecordedHandler<Name extends ExtensionEventName> = (
  event: ExtensionEventNamed<Name>,
  ctx: ExtensionContext,
) => Promise<ExtensionEventResult<Name> | void> | ExtensionEventResult<Name> | void;

export type RecordedHandlerTable = {
  readonly [Name in ExtensionEventName]: Array<RecordedHandler<Name>>;
};

export const emptyHandlerTable = (): RecordedHandlerTable => ({
  project_trust: [],
  resources_discover: [],
  session_start: [],
  session_info_changed: [],
  session_before_switch: [],
  session_before_fork: [],
  session_before_compact: [],
  session_compact: [],
  session_compact_failed: [],
  session_shutdown: [],
  mcp_servers_change: [],
  session_before_tree: [],
  session_tree: [],
  context: [],
  context_with_system: [],
  cache_warming_decision: [],
  before_provider_request: [],
  before_provider_headers: [],
  after_provider_response: [],
  provider_stream_event: [],
  before_agent_start: [],
  agent_start: [],
  agent_end: [],
  agent_before_settle: [],
  agent_settled: [],
  ui_prompt_start: [],
  ui_prompt_end: [],
  turn_start: [],
  turn_end: [],
  message_start: [],
  message_update: [],
  message_end: [],
  tool_execution_start: [],
  tool_execution_update: [],
  tool_execution_end: [],
  model_select: [],
  thinking_level_select: [],
  tool_call: [],
  tool_result: [],
  user_bash: [],
  input: [],
});

type EventDefaults = { readonly [Name in ExtensionEventName]?: ExtensionEventNamed<Name> };

const makeDefaultEvents = () =>
  ({
    session_start: { type: "session_start", reason: "startup" },
    session_shutdown: { type: "session_shutdown", reason: "quit" },
    session_tree: { type: "session_tree", newLeafId: null, oldLeafId: null },
    context: { type: "context", messages: [] },
    context_with_system: { type: "context_with_system", messages: [] },
    agent_start: { type: "agent_start" },
    agent_end: { type: "agent_end", messages: [] },
    agent_settled: { type: "agent_settled" },
  }) satisfies EventDefaults;

export type DefaultedEventName = keyof ReturnType<typeof makeDefaultEvents>;

export const defaultEvent = <Name extends ExtensionEventName>(
  name: Name,
): ExtensionEventNamed<Name> | undefined => {
  const defaults: EventDefaults = makeDefaultEvents();
  return defaults[name];
};
