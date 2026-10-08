import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { describe, expect, it, vi } from "vitest";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import { makeDefaultResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { createFooterInstallation } from "../src/footer/installation.ts";
import { makeProjection } from "../src/protocol/service.ts";

type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  data: ReadonlyFooterDataProvider,
) => { dispose(): void };

function installation() {
  const projection = makeProjection();
  MutableRef.update(projection, (current) => ({
    ...current,
    config: makeDefaultResolvedCosmicUiConfig(),
  }));
  const factories: FooterFactory[] = [];
  const context = () =>
    extensionContextFixture({
      mode: "tui",
      ui: {
        setFooter: vi.fn((factory) => {
          if (factory) factories.push(factory);
        }),
      },
    });
  const footer = createFooterInstallation({
    pi: extensionApiFixture({}),
    registry: { snapshot: () => ({ contributions: [] }) },
    projection,
    config: makeDefaultResolvedCosmicUiConfig,
    currentContext: () => undefined,
    refreshAfterBranchChange: () => undefined,
    onActiveChange: () => undefined,
  });
  const instance = (requestRender: () => void, factory = factories.at(-1)) => {
    if (!factory) throw new Error("Expected an installed footer factory.");
    return factory(
      { requestRender },
      plainTheme,
      opaqueFixture({ onBranchChange: () => () => undefined }),
    );
  };
  return { footer, context, instance, factories };
}

describe("footer installation render requests", () => {
  it("routes requests only to the newest instance until it is disposed", () => {
    const { footer, context, instance } = installation();
    footer.update(context());
    const older = vi.fn();
    const newer = vi.fn();
    const first = instance(older);
    const second = instance(newer);
    footer.requestRender();
    expect(newer).toHaveBeenCalledOnce();

    first.dispose();
    footer.requestRender();
    expect(newer).toHaveBeenCalledTimes(2);

    second.dispose();
    footer.requestRender();
    expect(newer).toHaveBeenCalledTimes(2);
    expect(older).not.toHaveBeenCalled();
  });

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
