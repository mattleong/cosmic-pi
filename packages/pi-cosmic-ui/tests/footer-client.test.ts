import { describe, expect, it } from "vitest";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { makeFooterStatusDeclaration } from "../src/boundary/host-status.ts";
import { createCosmicFooterClient } from "../src/footer/client.ts";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
} from "../src/protocol/protocol.ts";
import { eventBus } from "./support/host.ts";

describe("Cosmic footer client discovery", () => {
  it("distinguishes absent, inactive, and active hosts without losing visibility policy", () => {
    const bus = eventBus();
    const client = createCosmicFooterClient(bus.events, "provider");
    expect(client.query()).toBe(false);
    expect(client.installed).toBe(false);
    expect(client.isVisible("openai.usage")).toBe(true);

    let active = false;
    const hidden = ["openai.usage"];
    const stop = bus.respondToHostQuery(() => ({ active, ready: true, hidden }));
    expect(client.query()).toBe(false);
    expect(client.installed).toBe(true);
    expect(client.isVisible("openai.usage")).toBe(false);
    hidden.length = 0;
    expect(client.isVisible("openai.usage")).toBe(false);
    active = true;
    expect(client.query()).toBe(true);
    expect(client.isVisible("openai.usage")).toBe(true);
    stop();
    expect(client.query()).toBe(false);
    expect(client.installed).toBe(false);
  });

  it("waits for host preferences before enabling automatic provider work", () => {
    const bus = eventBus();
    const client = createCosmicFooterClient(bus.events, "provider");
    let ready = false;
    bus.respondToHostQuery(() => ({ active: false, ready, hidden: [] }));
    client.query();
    expect(client.installed).toBe(true);
    expect(client.isVisible("openai.usage")).toBe(false);
    ready = true;
    client.query();
    expect(client.isVisible("openai.usage")).toBe(true);
  });

  it("buffers contributions and removes stale entries through an inactive host", () => {
    const bus = eventBus();
    bus.respondToHostQuery(() => ({ active: false, ready: true, hidden: [] }));
    const client = createCosmicFooterClient(bus.events, "provider");
    client.query();
    bus.emitted.splice(0);
    client.upsert({ kind: "text", id: "usage", region: "details", text: "ready" });
    client.remove("usage");
    expect(bus.emitted.map(({ name }) => name)).toEqual([
      COSMIC_UI_FOOTER_UPSERT,
      COSMIC_UI_FOOTER_REMOVE,
    ]);
  });

  it("republishes status placement when a host becomes active", () => {
    const bus = eventBus();
    bus.respondToHostQuery(() => ({ active: false, ready: true, hidden: [] }));
    const declaration = makeFooterStatusDeclaration({
      events: bus.events,
      owner: "manager",
      statusKey: "manager-status",
      placement: { region: "identity", align: "right" },
    });
    declaration.activate(extensionContextFixture({ mode: "tui" }));
    bus.emitted.splice(0);
    bus.events.emit(COSMIC_UI_HOST_STATE, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      active: true,
      ready: true,
      hidden: [],
    });
    expect(bus.emitted).toContainEqual({
      name: COSMIC_UI_FOOTER_UPSERT,
      data: expect.objectContaining({
        owner: "manager",
        contribution: expect.objectContaining({ kind: "status", id: "manager-status" }),
      }),
    });
  });

  it("propagates visibility changes without an ownership change and contains consumer failure", () => {
    const bus = eventBus();
    const client = createCosmicFooterClient(bus.events, "provider");
    const visible: boolean[] = [];
    client.onHostStateChange(() => {
      visible.push(client.isVisible("openai.usage"));
      throw new Error("consumer failure");
    });
    for (const hidden of [[], ["openai.usage"], []]) {
      bus.events.emit(COSMIC_UI_HOST_STATE, {
        version: COSMIC_UI_PROTOCOL_VERSION,
        active: true,
        ready: true,
        hidden,
      });
    }
    expect(visible).toEqual([true, false, true]);
    expect(client.active).toBe(true);
  });

  it("rejects malformed or hostile host state without claiming an active host", () => {
    const bus = eventBus();
    const client = createCosmicFooterClient(bus.events, "provider");
    bus.respondToHostQuery(() =>
      Object.defineProperty({ active: false, ready: true, hidden: [] }, "active", {
        get() {
          throw new Error("hostile active getter");
        },
      }),
    );
    expect(client.query()).toBe(false);
    expect(client.installed).toBe(false);
    bus.events.emit(COSMIC_UI_HOST_STATE, { version: COSMIC_UI_PROTOCOL_VERSION, active: true });
    expect(client.active).toBe(false);
  });
});
