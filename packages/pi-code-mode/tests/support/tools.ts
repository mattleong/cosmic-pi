import type { NestedPiToolDefinitions } from "../../src/boundary/host-builtin-tools.ts";

export const nestedToolDefinitionsFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & NestedPiToolDefinitions => {
  // SAFETY: Each test invokes only the nested tool definitions explicitly implemented here.
  return fixture as Fixture & NestedPiToolDefinitions;
};
