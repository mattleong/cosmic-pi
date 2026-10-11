import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const executeDescriptor = (definition: Pick<ToolDefinition, "execute"> | undefined) =>
  definition && Object.getOwnPropertyDescriptor(definition, "execute");
