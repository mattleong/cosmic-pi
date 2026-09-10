import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";
import { NetworkAddresses, pinnedNetworkLookup } from "../src/platform/network-addresses.ts";

describe("network address capability", () => {
  it.live("resolves an owned loopback address", () =>
    Effect.gen(function* () {
      const service = yield* NetworkAddresses;
      expect(yield* service.resolve("127.0.0.1")).toEqual([{ address: "127.0.0.1", family: 4 }]);
    }).pipe(Effect.provide(NetworkAddresses.layer)),
  );
  test("pinned lookup never resolves a different hostname or unavailable family", () => {
    const lookup = pinnedNetworkLookup("fixture.example", [{ address: "127.0.0.1", family: 4 }]);
    let failures = 0;
    lookup("attacker.example", {}, (error) => {
      if (error) failures++;
    });
    lookup("fixture.example", { family: 6 }, (error) => {
      if (error) failures++;
    });
    expect(failures).toBe(2);
    lookup("fixture.example", {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe("127.0.0.1");
      expect(family).toBe(4);
    });
  });
  test("captures the approved address set rather than mutable caller data", () => {
    const addresses = [{ address: "93.184.216.34", family: 4 as const }];
    const lookup = pinnedNetworkLookup("fixture.example", addresses);
    addresses[0]!.address = "127.0.0.1";
    lookup("fixture.example", { all: true }, (error, resolved) => {
      expect(error).toBeNull();
      expect(resolved).toEqual([{ address: "93.184.216.34", family: 4 }]);
    });
  });
});
