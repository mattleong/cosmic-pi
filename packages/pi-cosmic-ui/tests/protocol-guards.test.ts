import { describe, expect, it } from "vitest";
import type { JsonObject } from "pi-cosmic-core";
import {
  COSMIC_UI_PROTOCOL_VERSION,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
  normalizeCosmicUiHostStateEvent,
} from "../src/protocol/protocol.ts";

const hostile = (message: string) => () => {
  throw new Error(message);
};
const proxyFailure = hostile("hostile protocol proxy");
const hostileProxy = () =>
  new Proxy({}, { get: proxyFailure, has: proxyFailure, ownKeys: proxyFailure });
const upsert = (contribution: JsonObject) =>
  normalizeCosmicFooterUpsertEvent({
    version: COSMIC_UI_PROTOCOL_VERSION,
    owner: "owner",
    contribution,
  });

describe("Cosmic UI protocol guards", () => {
  it("contains hostile proxies instead of throwing through the event boundary", () => {
    for (const normalize of [
      normalizeCosmicUiHostQuery,
      normalizeCosmicUiHostStateEvent,
      normalizeCosmicFooterUpsertEvent,
      normalizeCosmicFooterRemoveEvent,
    ]) {
      expect(normalize(hostileProxy())).toBeUndefined();
    }
  });
  it("answers a host query with a detached state and contains a hostile responder", () => {
    const received: Array<{ readonly hidden: readonly string[] }> = [];
    const hidden = ["usage"];
    const query = normalizeCosmicUiHostQuery({
      version: COSMIC_UI_PROTOCOL_VERSION,
      respond: (state: { readonly hidden: readonly string[] }) => {
        received.push(state);
      },
    });
    query?.respond({ active: true, ready: true, hidden });
    hidden.push("late");
    expect(received).toEqual([{ active: true, ready: true, hidden: ["usage"] }]);
    for (const respond of [hostile("hostile responder"), () => Promise.reject(new Error("late"))])
      expect(() =>
        normalizeCosmicUiHostQuery({ version: COSMIC_UI_PROTOCOL_VERSION, respond })?.respond({
          active: true,
          ready: true,
          hidden: [],
        }),
      ).not.toThrow();
  });
  it("keeps a contribution whose optional text, styling, or placement hints are invalid", () => {
    const event = upsert({
      kind: "text",
      id: "usage",
      region: "details",
      text: "Usage",
      compactText: 42,
      tone: "loud",
      color: "neon",
      label: "\x1b[2J",
      align: "center",
      priority: Number.NaN,
      decorates: "",
    });
    expect(event?.contribution).toEqual({
      kind: "text",
      id: "usage",
      region: "details",
      text: "Usage",
    });
  });

  it("still rejects contributions without a usable identity", () => {
    expect(
      upsert({ kind: "text", id: "usage", region: "elsewhere", text: "Usage" }),
    ).toBeUndefined();
  });
});
