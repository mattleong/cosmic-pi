import type { LookupFunction } from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { nodeLookup } from "./node-builtins.ts";

export class NetworkAddressError extends Schema.TaggedError<NetworkAddressError>()(
  "NetworkAddressError",
  { message: Schema.String },
) {}
export interface NetworkAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
export interface NetworkAddressesContract {
  readonly resolve: (
    hostname: string,
  ) => Effect.Effect<ReadonlyArray<NetworkAddress>, NetworkAddressError>;
}
const failure = () => new NetworkAddressError({ message: "Network address lookup failed." });
export class NetworkAddresses extends Context.Service<NetworkAddresses, NetworkAddressesContract>()(
  "pi-cosmic-core/platform/network-addresses/NetworkAddresses",
) {
  static readonly layer = Layer.succeed(this, {
    resolve: (hostname) =>
      Effect.callback<ReadonlyArray<NetworkAddress>, NetworkAddressError>((resume) => {
        try {
          nodeLookup(
            hostname.replace(/^\[|\]$/g, ""),
            { all: true, verbatim: true },
            (error, addresses) => {
              if (
                error ||
                addresses.length === 0 ||
                addresses.length > 64 ||
                addresses.some((a) => a.family !== 4 && a.family !== 6)
              ) {
                resume(Effect.fail(failure()));
              } else {
                resume(
                  Effect.succeed(
                    addresses.map((a) => ({ address: a.address, family: a.family === 4 ? 4 : 6 })),
                  ),
                );
              }
            },
          );
        } catch {
          resume(Effect.fail(failure()));
        }
        // getaddrinfo is not cancellable, but late results cannot open a connection.
      }),
  });
}

/** A connection must use exactly the address set its caller already approved. No DNS fallback. */
export const pinnedNetworkLookup = (
  hostname: string,
  addresses: ReadonlyArray<NetworkAddress>,
): LookupFunction => {
  const expected = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const pinned = addresses.map((address) => ({ ...address }));
  return (requested, options, callback) => {
    const family = options.family;
    const eligible = pinned.filter((address) => !family || family === address.family);
    if (requested.toLowerCase() !== expected || eligible.length === 0) {
      callback(new Error("Pinned network address is unavailable."), "", 4);
    } else if (options.all) {
      callback(null, eligible);
    } else {
      callback(null, eligible[0]!.address, eligible[0]!.family);
    }
  };
};
