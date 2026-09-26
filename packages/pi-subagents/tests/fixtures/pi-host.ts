import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { extensionApiFixture as hostApiFixture, opaqueFixture } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";

/** Core's host fixture with a no-op `registerMessageRenderer`, which extension setup calls. */
export const extensionApiFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI =>
  hostApiFixture({ registerMessageRenderer: () => undefined, ...fixture });

export const modelFixture = <Fixture extends object>(fixture: Fixture): Fixture & Model<Api> => {
  // SAFETY: Each test invokes only the model members explicitly implemented by its fixture.
  return fixture as Fixture & Model<Api>;
};

/** Pi's custom UI over the shared pinned-Pi fake: select keys confirm and cancel, and each
 * component mounts one microtask after its factory, as pinned Pi does. */
export const mountingCustomUi = (
  theme: Theme,
  created: (component: Component) => void,
  size: { readonly columns?: number; readonly rows?: number } = {},
) => {
  const host = fakeCustomSurfaceHost({
    ...size,
    theme,
    keybindings: opaqueFixture({
      matches: (data: string, id: string) =>
        id === "tui.select.confirm"
          ? matchesKey(data, Key.enter)
          : id === "tui.select.cancel"
            ? matchesKey(data, Key.escape)
            : false,
      getKeys: () => [],
    }),
  });
  const custom: ExtensionUIContext["custom"] = (factory, options) => {
    const opened = host.ctx.ui.custom((...args: Parameters<typeof factory>) => {
      const component = factory(...args);
      if (!Predicate.isPromiseLike(component)) created(component);
      return component;
    }, options);
    queueMicrotask(host.mount);
    return opened;
  };
  return { host, custom };
};
