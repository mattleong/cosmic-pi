import { describe, expect, it } from "vitest";
import {
  COSMIC_UI_PROTOCOL_VERSION,
  isCosmicFooterInvalidateEvent,
  isCosmicFooterRemoveEvent,
  isCosmicFooterUpsertEvent,
  isCosmicUiHostQuery,
  normalizeCosmicFooterInvalidateEvent,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
} from "../src/protocol/protocol.ts";

const hostileVersion = () =>
  Object.defineProperty({}, "version", {
    get() {
      throw new Error("hostile protocol getter");
    },
  });

describe("Cosmic UI protocol guards", () => {
  it("contains hostile getters instead of throwing through the event boundary", () => {
    for (const guard of [
      isCosmicUiHostQuery,
      isCosmicFooterUpsertEvent,
      isCosmicFooterRemoveEvent,
      isCosmicFooterInvalidateEvent,
    ]) {
      const input = hostileVersion();
      expect(() => guard(input)).not.toThrow();
      expect(guard(input)).toBe(false);
    }
    for (const normalize of [
      normalizeCosmicUiHostQuery,
      normalizeCosmicFooterUpsertEvent,
      normalizeCosmicFooterRemoveEvent,
      normalizeCosmicFooterInvalidateEvent,
    ]) {
      const input = hostileVersion();
      expect(() => normalize(input)).not.toThrow();
      expect(normalize(input)).toBeUndefined();
    }
  });

  it("contains hostile proxies outside schema decoding", () => {
    const hostileProxy = () =>
      new Proxy(
        {},
        {
          get() {
            throw new Error("hostile protocol proxy");
          },
          has() {
            throw new Error("hostile protocol proxy");
          },
          ownKeys() {
            throw new Error("hostile protocol proxy");
          },
        },
      );

    for (const normalize of [
      normalizeCosmicUiHostQuery,
      normalizeCosmicFooterUpsertEvent,
      normalizeCosmicFooterRemoveEvent,
      normalizeCosmicFooterInvalidateEvent,
    ]) {
      expect(() => normalize(hostileProxy())).not.toThrow();
      expect(normalize(hostileProxy())).toBeUndefined();
    }
  });

  it("agrees with normalization for accepted and version-mismatched messages", () => {
    const query = { version: COSMIC_UI_PROTOCOL_VERSION, respond: () => undefined };
    const upsert = {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "provider",
      contribution: { kind: "text", id: "usage", region: "metrics", text: "42%" },
    };
    const remove = { version: COSMIC_UI_PROTOCOL_VERSION, owner: "provider", id: "usage" };
    const invalidate = { version: COSMIC_UI_PROTOCOL_VERSION, owner: "provider" };

    expect(isCosmicUiHostQuery(query)).toBe(Boolean(normalizeCosmicUiHostQuery(query)));
    expect(isCosmicFooterUpsertEvent(upsert)).toBe(
      Boolean(normalizeCosmicFooterUpsertEvent(upsert)),
    );
    expect(isCosmicFooterRemoveEvent(remove)).toBe(
      Boolean(normalizeCosmicFooterRemoveEvent(remove)),
    );
    expect(isCosmicFooterInvalidateEvent(invalidate)).toBe(
      Boolean(normalizeCosmicFooterInvalidateEvent(invalidate)),
    );

    expect(isCosmicUiHostQuery({ ...query, version: 2 })).toBe(false);
    expect(isCosmicFooterUpsertEvent({ ...upsert, version: 2 })).toBe(false);
    expect(isCosmicFooterRemoveEvent({ ...remove, version: 2 })).toBe(false);
    expect(isCosmicFooterInvalidateEvent({ ...invalidate, version: 2 })).toBe(false);
  });
});
