import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Adds the host contract to a fixture while preserving its concrete mock members. */
export const extensionApiFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI => {
  // SAFETY: Callers use only the ExtensionAPI members explicitly implemented by each fixture.
  return fixture as Fixture & ExtensionAPI;
};

/** A shared fixture usable by both extension-event and command callback boundaries. */
export const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext & ExtensionCommandContext => {
  // SAFETY: Callers use only the host context members explicitly implemented by each fixture.
  return fixture as Fixture & ExtensionContext & ExtensionCommandContext;
};
