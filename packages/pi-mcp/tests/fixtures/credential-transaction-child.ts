import {
  nodeFsPromises as fs,
  nodePath as path,
} from "../../../pi-cosmic-core/src/platform/node-builtins.ts";
const { readFile, writeFile, unlink, appendFile } = fs;
const { join } = path;
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpCredentialStore } from "../../src/boundary/credential-store.ts";
import { McpSdkAuth } from "../../src/boundary/sdk-auth.ts";
import { makeMcpAuthWithAuthority } from "../../src/auth/service.ts";
import { oauthServer, preRegistered, testGrant } from "./auth.ts";

const [directory, mode, agentDirectory] = process.argv.slice(2);
const identity = "a".repeat(64);
const controller = new AbortController();
let trusted = true;
process.on("message", (message) => {
  if (message === "cancel") controller.abort();
  if (message === "revoke") trusted = false;
});
const file = join(directory!, "credential.json");
const server = {
  ...oauthServer(identity, { ...preRegistered, clientId: "test" }),
  id: "test",
  directory: agentDirectory!,
};
const grant = testGrant(identity, {
  clientId: "test",
  registration: "pre-registered",
  clientInformation: {},
  tokens: { access_token: "old", refresh_token: "rotate-once" },
  expiresAt: 1,
});
const wait = () => {
  const completion = Promise.withResolvers<void>();
  const receive = (message: string) => {
    if (message === "release") {
      process.off("message", receive);
      completion.resolve();
    }
  };
  process.on("message", receive);
  return completion.promise;
};
const storage = McpCredentialStore.layer({
  lockDirectory: join(directory!, "locks"),
  entryFactory: () =>
    Promise.resolve({
      getPassword: () => {
        process.send?.("native-read");
        return readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      },
      setPassword: (raw: string) => {
        if (mode === "write-hold" || mode === "write-cancel") {
          process.send?.("native-started");
          return wait()
            .then(() => writeFile(file, raw, { mode: 0o600 }))
            .then(() => {
              if (mode === "write-cancel") {
                process.send?.("native-completed");
                process.disconnect?.();
              }
            });
        }
        return writeFile(file, raw, { mode: 0o600 });
      },
      deleteCredential: () =>
        unlink(file)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          })
          .then(() => {
            process.send?.("deleted");
            return true;
          }),
    }),
});
const program = Effect.scoped(
  Effect.gen(function* () {
    const store = yield* McpCredentialStore;
    if (mode === "seed" || mode === "write-hold" || mode === "write-cancel") {
      yield* store.withTransaction(identity, (tx) => tx.write(grant));
      return;
    }
    const auth = yield* makeMcpAuthWithAuthority({
      isTrusted: () => trusted,
      check: () => Effect.void,
    }).pipe(
      Effect.provideService(McpSdkAuth, {
        login: () => Effect.succeed(grant),
        token: (_server, current) =>
          Schema.decodeUnknownEffect(Schema.Struct({ access_token: Schema.String }))(
            current.tokens,
          ).pipe(
            Effect.map((tokens) => tokens.access_token),
            Effect.orDie,
          ),
        refresh: (_server, previous) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() => appendFile(join(directory!, "refreshes"), "refresh\n"));
            process.send?.("refresh-started");
            if (mode === "refresh-hold") yield* Effect.tryPromise(wait);
            return {
              ...previous,
              expiresAt: Number.MAX_SAFE_INTEGER,
              tokens: { access_token: "fresh", refresh_token: "successor" },
            };
          }).pipe(Effect.orDie),
      }),
    );
    if (mode === "logout") yield* auth.logout(server);
    else process.send?.({ token: yield* auth.access(server) });
  }),
).pipe(Effect.provide(storage));
process.send?.("attempting");
Effect.runPromise(program, { signal: controller.signal }).then(
  () => {
    process.send?.("finished");
    process.disconnect?.();
  },
  () => {
    if (mode === "write-cancel") process.send?.("cancelled");
    else {
      process.send?.("failed");
      process.disconnect?.();
    }
  },
);
