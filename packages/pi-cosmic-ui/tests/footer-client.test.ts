import { describe, expect, it } from "vitest";
import { createCosmicFooterClient } from "../src/footer/client.ts";
import { COSMIC_UI_HOST_STATE, COSMIC_UI_PROTOCOL_VERSION } from "../src/protocol/protocol.ts";
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
});
