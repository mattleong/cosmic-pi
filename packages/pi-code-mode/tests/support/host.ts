import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const extensionApiFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI => {
  // SAFETY: Each test uses only the ExtensionAPI members explicitly implemented by its fixture.
  return fixture as Fixture & ExtensionAPI;
};

export const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext & ExtensionCommandContext => {
  // SAFETY: Each test uses only the host context members explicitly implemented by its fixture.
  return fixture as Fixture & ExtensionContext & ExtensionCommandContext;
};
