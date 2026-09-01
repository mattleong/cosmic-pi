import { describe, expect, it } from "vitest";
import {
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
});
