import {
  createExtensionRuntime,
  defineTool,
  ExtensionRunner,
  SessionManager,
  type ContextEvent,
  type Extension,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageRenderer,
  type RegisteredCommand,
  type SlashCommandInfo,
  type SourceInfo,
  type ToolDefinition,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  defaultEvent,
  emptyHandlerTable,
  type DefaultedEventName,
  type ExtensionEventName,
  type ExtensionEventNamed,
  type RecordedHandler,
} from "./extension-events.ts";
import * as Arr from "effect/Array";
import { extensionApiFixture } from "./host.ts";
import { overlay } from "./overlay.ts";

type ToolSchema = ToolDefinition["parameters"];
type HandlerFn = Extension["handlers"] extends Map<string, Array<infer H>> ? H : never;
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;

// Pi stores every handler untyped and passes it the event of its name and the context.
const hostHandler =
  <Name extends "context" | "context_with_system">(handler: RecordedHandler<Name>): HandlerFn =>
  (event, ctx) =>
    Promise.resolve(handler(event as ExtensionEventNamed<Name>, ctx as ExtensionContext));

export interface RecordedEmit {
  <Name extends DefaultedEventName>(
    name: Name,
    ctx: ExtensionContext,
    event?: ExtensionEventNamed<Name>,
  ): Promise<void>;
  <Name extends ExtensionEventName>(
    name: Name,
    ctx: ExtensionContext,
    event: ExtensionEventNamed<Name>,
  ): Promise<void>;
}

export interface RecordedHandlers {
  readonly has: (name: ExtensionEventName) => boolean;
  readonly get: <Name extends ExtensionEventName>(
    name: Name,
  ) => ReadonlyArray<RecordedHandler<Name>>;
}

interface RecordingExtensionHostOptions {
  readonly source?: SourceInfo;
  readonly toolSource?: SourceInfo;
}

const defaultSource: SourceInfo = {
  source: "local",
  path: "/extensions/test/index.ts",
  scope: "user",
  origin: "top-level",
};

export const recordingExtensionHost = (
  options: RecordingExtensionHostOptions = {},
  overrides: Partial<ExtensionAPI> = {},
) => {
  const source = options.source ?? defaultSource;
  const table = emptyHandlerTable();
  const commands = new Map<string, Command>();
  const tools = new Map<string, ToolDefinition>();
  const registrations: ToolDefinition[] = [];
  const toolRenderers: ToolRendererResolver[] = [];
  const messageRenderers = new Map<string, MessageRenderer<never>>();
  let active: ReadonlyArray<string> = ["read"];
  let rejectTools = false;
  const on = <Name extends ExtensionEventName>(name: Name, handler: RecordedHandler<Name>) => {
    const registered = table[name];
    registered.push(handler);
    return () => {
      const index = registered.indexOf(handler);
      if (index >= 0) registered.splice(index, 1);
    };
  };
  const handlers: RecordedHandlers = {
    has: (name) => table[name].length > 0,
    get: (name) => table[name],
  };
  const pi = overlay(
    extensionApiFixture({
      on,
      registerCommand: (name: string, command: Command) => {
        commands.set(name, command);
      },
      registerTool: <TParams extends ToolSchema, TDetails, TState>(
        definition: ToolDefinition<TParams, TDetails, TState>,
      ) => {
        if (rejectTools) throw new Error("stale extension handle");
        const tool: ToolDefinition = defineTool(definition);
        const fresh = !tools.has(tool.name) && tool.defaultActive !== false;
        tools.set(tool.name, tool);
        registrations.push(tool);
        if (fresh) active = [...active, tool.name];
      },
      registerToolRenderer: (resolver: ToolRendererResolver) => {
        toolRenderers.push(resolver);
      },
      registerMessageRenderer: <T>(customType: string, render: MessageRenderer<T>) => {
        messageRenderers.set(customType, render);
      },
      getAllTools: () =>
        Arr.map([...tools.values()], (tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          exposure: tool.exposure ?? "direct",
          sourceInfo: options.toolSource ?? source,
        })),
      getCommands: () =>
        Arr.map([...commands], ([name, command]) => {
          const info: SlashCommandInfo = { name, source: "extension", sourceInfo: source };
          if (command.description !== undefined) info.description = command.description;
          return info;
        }),
      getActiveTools: () => [...active],
      setActiveTools: (names: ReadonlyArray<string>) => {
        active = Arr.filter(names, (name) => name === "read" || tools.has(name));
      },
    }),
    overrides,
  );
  const resolve = (name: string, base?: ToolRenderers): ToolRenderers | undefined => {
    const next = (index: number): ToolRenderers | undefined => {
      const resolver = toolRenderers[index];
      return resolver === undefined
        ? (base ?? tools.get(name))
        : resolver(name, () => next(index + 1));
    };
    return next(0);
  };
  const emit: RecordedEmit = <Name extends ExtensionEventName>(
    name: Name,
    ctx: ExtensionContext,
    event?: ExtensionEventNamed<Name>,
  ): Promise<void> => {
    const delivered = event ?? defaultEvent(name);
    if (delivered === undefined)
      return Promise.reject(new Error(`Emitting ${name} requires an event.`));
    const registered = table[name];
    const run = (index: number): Promise<void> => {
      const handler = registered[index];
      return handler === undefined
        ? Promise.resolve()
        : Promise.resolve(handler(delivered, ctx)).then(() => run(index + 1));
    };
    return run(0);
  };
  /**
   * The messages Pi's own `ExtensionRunner` sends to the model after the recorded `context` and
   * `context_with_system` handlers, including how Pi copies the transcript and restores system
   * messages. `messages` stands in for the stored transcript; handlers receive `ctx`. Rejects when
   * a handler threw, which Pi would only report.
   */
  const modelContext = (
    ctx: ExtensionContext,
    messages: ContextEvent["messages"],
  ): Promise<ContextEvent["messages"]> => {
    const runner = new ExtensionRunner(
      [
        {
          path: source.path,
          resolvedPath: source.path,
          sourceInfo: source,
          handlers: new Map<string, HandlerFn[]>([
            ["context", Arr.map(table.context, hostHandler)],
            ["context_with_system", Arr.map(table.context_with_system, hostHandler)],
          ]),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
      ],
      createExtensionRuntime(),
      ctx.cwd,
      // Unused: every handler receives `ctx`.
      SessionManager.inMemory(ctx.cwd),
      ctx.modelRegistry,
    );
    runner.createContext = () => ctx;
    const errors: string[] = [];
    runner.onError((error) => errors.push(`${error.event}: ${error.error}`));
    return runner
      .emitContext(messages)
      .then((sent) =>
        errors.length === 0 ? sent : Promise.reject(new Error(Arr.join(errors, "\n"))),
      );
  };
  return {
    pi,
    handlers,
    modelContext,
    commands,
    tools,
    registrations,
    toolRenderers,
    messageRenderers,
    resolve,
    emit,
    active: () => [...active],
    rejectTools: (reject: boolean) => {
      rejectTools = reject;
    },
  };
};
