import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AdvisorHostEventHandler = (
  event: never,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

export type AdvisorHostCommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];

export type AdvisorHostCommandHandler = (
  args: string,
  ctx: Parameters<NonNullable<AdvisorHostCommandDefinition["handler"]>>[1],
) => unknown | Promise<unknown>;

/** Explicit bridge between controller-owned handlers and the thin Pi registration adapter. */
export interface AdvisorHostBindings {
  readonly registerEvent: ExtensionAPI["on"];
  readonly registerCommand: (name: string, definition: AdvisorHostCommandDefinition) => void;
  readonly eventHandler: (name: string) => AdvisorHostEventHandler | undefined;
  readonly commandHandler: (name: string) => AdvisorHostCommandHandler | undefined;
  readonly commandDefinition: (name: string) => AdvisorHostCommandDefinition | undefined;
}

export interface AdvisorHostBindingMaps {
  readonly eventHandlers?: Map<string, AdvisorHostEventHandler>;
  readonly commandHandlers?: Map<string, AdvisorHostCommandHandler>;
  readonly commandDefinitions?: Map<string, AdvisorHostCommandDefinition>;
}

export const makeAdvisorHostBindings = (maps: AdvisorHostBindingMaps = {}): AdvisorHostBindings => {
  const eventHandlers = maps.eventHandlers ?? new Map<string, AdvisorHostEventHandler>();
  const commandHandlers = maps.commandHandlers ?? new Map<string, AdvisorHostCommandHandler>();
  const commandDefinitions =
    maps.commandDefinitions ?? new Map<string, AdvisorHostCommandDefinition>();

  const registerEvent = ((name: string, handler: AdvisorHostEventHandler) => {
    eventHandlers.set(name, handler);
  }) as ExtensionAPI["on"];

  return {
    registerEvent,
    registerCommand: (name, definition) => {
      commandDefinitions.set(name, definition);
      commandHandlers.set(name, definition.handler as AdvisorHostCommandHandler);
    },
    eventHandler: (name) => eventHandlers.get(name),
    commandHandler: (name) => commandHandlers.get(name),
    commandDefinition: (name) => commandDefinitions.get(name),
  };
};
