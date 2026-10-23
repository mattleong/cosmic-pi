import { describe, expect, it } from "vitest";
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

describe("Cosmic UI protocol guards", () => {
  it.each([["proxies", hostileProxy]])(
    "contains hostile %s instead of throwing through the event boundary",
    (_kind, input) => {
      for (const normalize of [
        normalizeCosmicUiHostQuery,
        normalizeCosmicUiHostStateEvent,
        normalizeCosmicFooterUpsertEvent,
        normalizeCosmicFooterRemoveEvent,
      ]) {
        expect(normalize(input())).toBeUndefined();
      }
    },
  );
  it("keeps a contribution whose optional text, styling, or placement hints are invalid", () => {
    const event = normalizeCosmicFooterUpsertEvent({
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "owner",
      contribution: {
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
      },
    });
    expect(event?.contribution).toEqual({
      kind: "text",
      id: "usage",
      region: "details",
      text: "Usage",
    });
  });

  it("accepts every foreground theme token as a contribution color", () => {
    const event = normalizeCosmicFooterUpsertEvent({
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "owner",
      contribution: {
        kind: "text",
        id: "usage",
        region: "details",
        text: "Usage",
        color: "scrollbarThumb",
        tone: "accent",
      },
    });
    expect(event?.contribution).toMatchObject({ color: "scrollbarThumb", tone: "accent" });
  });

  it("still rejects contributions without a usable identity", () => {
    expect(
      normalizeCosmicFooterUpsertEvent({
        version: COSMIC_UI_PROTOCOL_VERSION,
        owner: "owner",
        contribution: { kind: "text", id: "usage", region: "elsewhere", text: "Usage" },
      }),
    ).toBeUndefined();
  });
});
