import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { describe, expect, it, vi } from "vitest";
import {
  extensionApiFixture,
  extensionContextFixture,
  footerDataFixture,
  plainTheme,
  tuiFixture,
} from "pi-cosmic-core/testing";
import { defaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { createFooterInstallation } from "../src/footer/installation.ts";
import { createProjection } from "../src/protocol/service.ts";

type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;

const mountFooter = (factory: FooterFactory | undefined, requestRender: () => void) => {
  if (!factory) throw new Error("Expected an installed footer factory.");
  const component = factory(tuiFixture({ requestRender }), plainTheme, footerDataFixture());
  if (!component.dispose) throw new Error("Expected a disposable footer.");
  return { dispose: () => component.dispose?.() };
};

function installation() {
  const projection = createProjection();
  MutableRef.update(projection, (current) => ({
    ...current,
    config: defaultResolvedCosmicUiConfig(),
  }));
  const factories: FooterFactory[] = [];
  const context = () =>
    extensionContextFixture({
      mode: "tui",
      ui: {
        setFooter: (factory) => {
          if (factory) factories.push(factory);
        },
      },
    });
  const footer = createFooterInstallation({
    pi: extensionApiFixture({}),
    registry: { snapshot: () => ({ contributions: [] }) },
    projection,
    config: defaultResolvedCosmicUiConfig,
    currentContext: () => undefined,
    refreshAfterBranchChange: () => undefined,
    onActiveChange: () => undefined,
  });
  const instance = (requestRender: () => void, factory?: FooterFactory) =>
    mountFooter(factory ?? factories.at(-1), requestRender);
  return { footer, context, instance, factories };
}

describe("footer installation render requests", () => {
  it("keeps a replaced attempt from receiving or clearing the replacement's requests", () => {
    const { footer, context, instance, factories } = installation();
    footer.update(context());
    const staleFactory = factories.at(-1);
    const stale = vi.fn();
    const replaced = instance(stale);
    footer.update(context());
    const current = vi.fn();
    instance(current);

    replaced.dispose();
    instance(stale, staleFactory).dispose();
    footer.requestRender();
    expect(current).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();

    footer.uninstall();
    footer.requestRender();
    expect(current).toHaveBeenCalledOnce();
  });

  it("isolates a throwing render request", () => {
    const { footer, context, instance } = installation();
    footer.update(context());
    instance(() => {
      throw new Error("secret render payload");
    });
    expect(() => footer.requestRender()).not.toThrow();
  });
});
