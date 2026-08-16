import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";

export const extensionApiFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI => {
  // SAFETY: Each test invokes only the ExtensionAPI members explicitly implemented here.
  return fixture as Fixture & ExtensionAPI;
};

export const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext & ExtensionCommandContext => {
  // SAFETY: Each test invokes only the host context members explicitly implemented here.
  return fixture as Fixture & ExtensionContext & ExtensionCommandContext;
};

export const footerDataProviderFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ReadonlyFooterDataProvider => {
  // SAFETY: Each test invokes only the footer-data members explicitly implemented here.
  return fixture as Fixture & ReadonlyFooterDataProvider;
};

export const eventBusFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI["events"] => {
  // SAFETY: Each client test invokes only emit on its event-bus fixture.
  return fixture as Fixture & ExtensionAPI["events"];
};

export const abortSignalFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & AbortSignal => {
  // SAFETY: Each test invokes only the AbortSignal members explicitly implemented here.
  return fixture as Fixture & AbortSignal;
};
