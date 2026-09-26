import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { KeychainEntryFactory } from "../../src/boundary/keychain.ts";

/** One in-memory native password shared by every account, recording the accounts opened. */
export const memoryKeychain = (initial?: string, missing: null | undefined = undefined) => {
  let password: string | null | undefined = initial ?? missing;
  const accounts = new Set<string>();
  const factory: KeychainEntryFactory = (service, account) => {
    accounts.add(`${service}/${account}`);
    return Promise.resolve({
      getPassword: () => Promise.resolve(password),
      setPassword: (value) => {
        password = value;
        return Promise.resolve();
      },
      deleteCredential: () => {
        password = missing;
        return Promise.resolve(true);
      },
    });
  };
  return { factory, accounts, value: () => password };
};

/** Native writes ignore Effect cancellation until `release` settles the latest held write. */
export const heldKeychain = ({ firstOnly = false }: { readonly firstOnly?: boolean } = {}) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let settle: () => void = () => undefined;
    let password: string | undefined;
    let held = false;
    let deleted = false;
    const factory: KeychainEntryFactory = () =>
      Promise.resolve({
        getPassword: () => Promise.resolve(password),
        setPassword: (value) => {
          if (firstOnly && held) {
            password = value;
            return Promise.resolve();
          }
          held = true;
          const completion = Promise.withResolvers<void>();
          settle = () => {
            password = value;
            completion.resolve();
          };
          Deferred.doneUnsafe(entered, Effect.void);
          return completion.promise;
        },
        deleteCredential: () => {
          deleted = true;
          password = undefined;
          return Promise.resolve(true);
        },
      });
    return {
      factory,
      entered,
      release: () => settle(),
      value: () => password,
      deleted: () => deleted,
    };
  });
