import type { ExtensionAPI, ExtensionHandler } from "@earendil-works/pi-coding-agent";

export type AdvisorHostEventHandler = ExtensionHandler<never, any>;

export type AdvisorHostCommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];

export type AdvisorHostCommandHandler = NonNullable<AdvisorHostCommandDefinition["handler"]>;

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

  // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
  const registerEvent = ((name: string, handler: AdvisorHostEventHandler) => {
    eventHandlers.set(name, handler);
  }) as ExtensionAPI["on"];

  return {
    registerEvent,
    registerCommand: (name, definition) => {
      commandDefinitions.set(name, definition);
      // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
      commandHandlers.set(name, definition.handler as AdvisorHostCommandHandler);
    },
    eventHandler: (name) => eventHandlers.get(name),
    commandHandler: (name) => commandHandlers.get(name),
    commandDefinition: (name) => commandDefinitions.get(name),
  };
};
