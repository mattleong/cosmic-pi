import { describe, expect, it } from "vitest";
import {
  PROTOCOL_FINGERPRINT_ENV,
  protocolFingerprint,
  protocolMismatch,
} from "../src/boundary/protocol-fingerprint.ts";

describe("root-child protocol fingerprint", () => {
  it("rejects a child that runs a different Pi version than its parent", () => {
    const parentOnOlderPi = protocolFingerprint("1.1.9");
    expect(parentOnOlderPi).not.toBe(protocolFingerprint());
    expect(protocolMismatch({ [PROTOCOL_FINGERPRINT_ENV]: parentOnOlderPi })).toContain(
      "Restart Pi",
    );
  });
});
