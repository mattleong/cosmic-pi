import { describe, expect, test } from "vitest";
import { COSMIC_UI_PROTOCOL_VERSION, isCosmicFooterUpsertEvent } from "../src/protocol.ts";

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
