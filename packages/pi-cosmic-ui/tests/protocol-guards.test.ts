import { describe, expect, it } from "vitest";
import {
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
  normalizeCosmicUiHostStateEvent,
} from "../src/protocol/protocol.ts";

const hostile = (message: string) => () => {
  throw new Error(message);
};
const hostileVersion = () =>
  Object.defineProperty({}, "version", { get: hostile("hostile protocol getter") });
const proxyFailure = hostile("hostile protocol proxy");
const hostileProxy = () =>
  new Proxy({}, { get: proxyFailure, has: proxyFailure, ownKeys: proxyFailure });

describe("Cosmic UI protocol guards", () => {
  it.each([
    ["getters", hostileVersion],
    ["proxies", hostileProxy],
  ])("contains hostile %s instead of throwing through the event boundary", (_kind, input) => {
    for (const normalize of [
      normalizeCosmicUiHostQuery,
      normalizeCosmicUiHostStateEvent,
      normalizeCosmicFooterUpsertEvent,
      normalizeCosmicFooterRemoveEvent,
    ]) {
      expect(normalize(input())).toBeUndefined();
    }
  });
});
