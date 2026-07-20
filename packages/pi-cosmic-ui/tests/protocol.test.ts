import { describe, expect, test } from "vitest";
import {
  COSMIC_UI_PROTOCOL_VERSION,
  isCosmicFooterInvalidateEvent,
  isCosmicFooterRemoveEvent,
  isCosmicFooterUpsertEvent,
  isCosmicUiHostQuery,
} from "../src/protocol.ts";

function event(contribution: Record<string, unknown>) {
  return { version: COSMIC_UI_PROTOCOL_VERSION, owner: "test-owner", contribution };
}

describe("Cosmic UI protocol validation", () => {
  test("accepts valid text contributions and rejects malformed optional fields", () => {
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "text",
          id: "status",
          region: "details",
          text: "ready",
          tone: "success",
          align: "right",
          priority: 10,
        }),
      ),
    ).toBe(true);
    expect(
      isCosmicFooterUpsertEvent(
        event({ kind: "text", id: "status", region: "details", text: "ready", tone: "accent" }),
      ),
    ).toBe(true);
    expect(
      isCosmicFooterUpsertEvent(
        event({ kind: "text", id: "status", region: "details", text: "ready", tone: "purple" }),
      ),
    ).toBe(false);
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "text",
          id: "status",
          region: "details",
          text: "ready",
          priority: Number.NaN,
        }),
      ),
    ).toBe(false);
  });

  test("validates host, remove, and invalidate payloads through schemas", () => {
    expect(isCosmicUiHostQuery({ version: 1, respond() {} })).toBe(true);
    expect(isCosmicUiHostQuery({ version: 1, respond: "later" })).toBe(false);
    expect(isCosmicFooterRemoveEvent({ version: 1, owner: "owner", id: "item" })).toBe(true);
    expect(isCosmicFooterRemoveEvent({ version: 1, owner: "", id: "item" })).toBe(false);
    expect(isCosmicFooterInvalidateEvent({ version: 1 })).toBe(true);
    expect(isCosmicFooterInvalidateEvent({ version: 1, owner: 42 })).toBe(false);
  });

  test("returns false for hostile accessors and proxies without throwing", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
        ownKeys() {
          throw new Error("hostile keys");
        },
      },
    );
    const throwingVersion = Object.defineProperty({}, "version", {
      get() {
        throw new Error("hostile version");
      },
    });
    for (const guard of [
      isCosmicUiHostQuery,
      isCosmicFooterUpsertEvent,
      isCosmicFooterRemoveEvent,
      isCosmicFooterInvalidateEvent,
    ]) {
      expect(() => guard(hostile)).not.toThrow();
      expect(guard(hostile)).toBe(false);
      expect(() => guard(throwingVersion)).not.toThrow();
      expect(guard(throwingVersion)).toBe(false);
    }
  });

  test("validates surface placement and lifecycle callbacks", () => {
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "surface",
          id: "media",
          region: "media",
          preferredWidth: 8,
          preferredPlacement: "inline-right",
          render: () => [],
        }),
      ),
    ).toBe(true);
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "surface",
          id: "media",
          region: "media",
          preferredWidth: 8,
          preferredPlacement: "floating",
          render: () => [],
        }),
      ),
    ).toBe(false);
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "surface",
          id: "media",
          region: "media",
          preferredWidth: 8,
          attach: "later",
          render: () => [],
        }),
      ),
    ).toBe(false);
  });
});
