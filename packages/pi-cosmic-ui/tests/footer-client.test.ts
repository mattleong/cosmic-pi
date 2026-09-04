import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeFooterStatusDeclaration } from "../src/boundary/host-status.ts";
import { createCosmicFooterClient } from "../src/footer/client.ts";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  type CosmicUiHostQuery,
} from "../src/protocol/protocol.ts";
import { extensionContextFixture } from "./support/host.ts";

type BusHandler = Parameters<ExtensionAPI["events"]["on"]>[1];

function eventBus() {
  const listeners = new Map<string, Set<BusHandler>>();
  const emitted: Array<{ readonly name: string; readonly data: unknown }> = [];
  const events = {
    emit<DataInput>(name: string, data: DataInput) {
      emitted.push({ name, data });
      for (const listener of listeners.get(name) ?? []) listener(data);
    },
    on(name: string, listener: BusHandler) {
      const entries = listeners.get(name) ?? new Set<BusHandler>();
      entries.add(listener);
      listeners.set(name, entries);
      return () => entries.delete(listener);
    },
  };
  // SAFETY: The fixture implements the complete emit/on event-bus surface used by the client.
  return { events: events as ExtensionAPI["events"], emitted };
}

describe("Cosmic footer client discovery", () => {
  it("distinguishes an absent, inactive, and active host on every query", () => {
    const bus = eventBus();
    const client = createCosmicFooterClient(bus.events, "provider");

    expect(client.query()).toBe(false);
    expect(client.installed).toBe(false);

    let active = false;
    bus.events.on(COSMIC_UI_HOST_QUERY, (data) => {
      // SAFETY: This listener is registered only for the typed host-query event emitted by the client.
      (data as CosmicUiHostQuery).respond({ active });
    });
    expect(client.query()).toBe(false);
    expect(client.installed).toBe(true);
    expect(client.active).toBe(false);

    active = true;
    expect(client.query()).toBe(true);
    expect(client.installed).toBe(true);
    expect(client.active).toBe(true);
  });

  it("buffers contributions and removes stale entries through an installed inactive host", () => {
    const bus = eventBus();
    bus.events.on(COSMIC_UI_HOST_QUERY, (data) => {
      // SAFETY: This listener is registered only for the typed host-query event emitted by the client.
      (data as CosmicUiHostQuery).respond({ active: false });
    });
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

  it("registers status placement through an installed inactive host", () => {
    const bus = eventBus();
    bus.events.on(COSMIC_UI_HOST_QUERY, (data) => {
      // SAFETY: This listener is registered only for the typed host-query event emitted by the client.
      (data as CosmicUiHostQuery).respond({ active: false });
    });
    const declaration = makeFooterStatusDeclaration({
      events: bus.events,
      owner: "manager",
      statusKey: "manager-status",
      placement: { region: "identity", align: "right" },
    });

    declaration.activate(extensionContextFixture({ mode: "tui" }));

    expect(bus.emitted).toContainEqual({
      name: COSMIC_UI_FOOTER_UPSERT,
      data: expect.objectContaining({
        owner: "manager",
        contribution: expect.objectContaining({ kind: "status", id: "manager-status" }),
      }),
    });
  });

  it("tracks host ownership broadcasts and contains consumer failures", () => {
    const bus = eventBus();
    const client = createCosmicFooterClient(bus.events, "provider");
    const observed: boolean[] = [];
    client.onHostStateChange((state) => {
      observed.push(state.active);
      if (!state.active) throw new Error("consumer failure");
    });

    bus.events.emit(COSMIC_UI_HOST_STATE, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      active: true,
    });
    bus.events.emit(COSMIC_UI_HOST_STATE, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      active: false,
    });

    expect(observed).toEqual([true, false]);
    expect(client.installed).toBe(true);
    expect(client.active).toBe(false);
  });

  it("keeps legacy no-argument host responses compatible", () => {
    const bus = eventBus();
    bus.events.on(COSMIC_UI_HOST_QUERY, (data) => {
      // SAFETY: This listener is registered only for the typed host-query event emitted by the client.
      (data as CosmicUiHostQuery).respond();
    });
    const client = createCosmicFooterClient(bus.events, "provider");

    expect(client.query()).toBe(true);
    expect(client.installed).toBe(true);
  });

  it("contains hostile host responses", () => {
    const bus = eventBus();
    bus.events.on(COSMIC_UI_HOST_QUERY, (data) => {
      const hostile = Object.defineProperty({}, "active", {
        get() {
          throw new Error("hostile active getter");
        },
      });
      // SAFETY: This listener receives the typed query; the hostile state assertion is deliberate.
      (data as CosmicUiHostQuery).respond(hostile as { active: boolean });
    });
    const client = createCosmicFooterClient(bus.events, "provider");

    expect(client.query()).toBe(false);
    expect(client.installed).toBe(true);
    expect(client.active).toBe(false);
  });
});
