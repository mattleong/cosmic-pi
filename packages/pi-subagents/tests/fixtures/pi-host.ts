import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const extensionApiFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI => {
  // SAFETY: Each test invokes only the ExtensionAPI members explicitly implemented by its fixture.
  return fixture as Fixture & ExtensionAPI;
};

export const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext & ExtensionCommandContext => {
  // SAFETY: Each test invokes only the host context members explicitly implemented by its fixture.
  return fixture as Fixture & ExtensionContext & ExtensionCommandContext;
};

export const modelFixture = <Fixture extends object>(fixture: Fixture): Fixture & Model<Api> => {
  // SAFETY: Each test invokes only the model members explicitly implemented by its fixture.
  return fixture as Fixture & Model<Api>;
};
