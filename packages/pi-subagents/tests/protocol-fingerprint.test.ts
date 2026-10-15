import { describe, expect, it } from "vitest";
import {
  PROTOCOL_FINGERPRINT_ENV,
  protocolFingerprint,
  protocolMismatch,
} from "../src/boundary/protocol-fingerprint.ts";

describe("root-child protocol fingerprint", () => {
  it("accepts a child started by a parent with the same protocol code", () => {
    expect(protocolMismatch({ [PROTOCOL_FINGERPRINT_ENV]: protocolFingerprint() })).toBeUndefined();
    expect(protocolMismatch({})).toBeUndefined();
  });

  it("rejects a child whose parent loaded different protocol code", () => {
    expect(protocolMismatch({ [PROTOCOL_FINGERPRINT_ENV]: "0000000000000000" })).toContain(
      "Restart Pi",
    );
  });

  it("rejects a child that runs a different Pi version than its parent", () => {
    const parentOnOlderPi = protocolFingerprint("1.1.9");
    expect(parentOnOlderPi).not.toBe(protocolFingerprint());
    expect(protocolMismatch({ [PROTOCOL_FINGERPRINT_ENV]: parentOnOlderPi })).toContain(
      "Restart Pi",
    );
  });
});
