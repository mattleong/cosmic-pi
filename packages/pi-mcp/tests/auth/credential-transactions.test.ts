import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpCredentialStore } from "../../src/boundary/credential-store.ts";
import type { KeychainEntryFactory } from "../../src/boundary/keychain.ts";
import {
  nodeFsPromises as fs,
  nodePath as path,
  nodeSpawn,
} from "../../../pi-cosmic-core/src/platform/node-builtins.ts";

const root = Effect.acquireRelease(
  Effect.tryPromise(() => fs.mkdtemp(path.join(tmpdir(), "mcp-transactions-"))),
  (directory) =>
    Effect.tryPromise(() => fs.rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
);
const kill = (child: ReturnType<typeof nodeSpawn>) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
    const exited = () => resume(Effect.void);
    child.once("exit", exited);
    child.kill("SIGKILL");
    return Effect.sync(() => child.off("exit", exited));
  });
const launch = (directory: string, mode: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = nodeSpawn(
        process.execPath,
        [
          "--import",
          "jiti/register",
          fileURLToPath(new URL("../fixtures/credential-transaction-child.ts", import.meta.url)),
          directory,
          mode,
          path.join(directory, `agent-${mode}`),
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      const messages: unknown[] = [];
      child.on("message", (message) => messages.push(message));
      const wait = (expected: string) =>
        Effect.callback<void>((resume) => {
          if (messages.includes(expected)) {
            resume(Effect.void);
            return;
          }
          const receive = (message: string | { token: string }) => {
            if (message === expected) resume(Effect.void);
          };
          child.on("message", receive);
          return Effect.sync(() => child.off("message", receive));
        }).pipe(Effect.timeout("15 seconds"));
      return { child, messages, wait };
    }),
    ({ child }) => kill(child),
  );
const run = (directory: string, mode: string) =>
  Effect.flatMap(launch(directory, mode), (child) => child.wait("finished"));

it.live(
  "rereads after another process refreshes and consumes a rotating token only once",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      yield* run(directory, "seed");
      const first = yield* launch(directory, "refresh-hold");
      yield* first.wait("refresh-started");
      const second = yield* launch(directory, "access");
      yield* second.wait("attempting");
      yield* Effect.sleep(100);
      expect(second.messages).not.toContain("refresh-started");
      first.child.send?.("release");
      yield* Effect.all([first.wait("finished"), second.wait("finished")], {
        concurrency: "unbounded",
      });
      expect(first.messages).toContainEqual({ token: "fresh" });
      expect(second.messages).toContainEqual({ token: "fresh" });
      expect(
        yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "refreshes"), "utf8")),
      ).toBe("refresh\n");
    }).pipe(Effect.scoped),
  30_000,
);

it.live(
  "logout waits for a late native save, then removes it instead of resurrecting a grant",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const writer = yield* launch(directory, "write-hold");
      yield* writer.wait("native-started");
      const logout = yield* launch(directory, "logout");
      yield* logout.wait("attempting");
      yield* Effect.sleep(100);
      expect(logout.messages).not.toContain("deleted");
      writer.child.send?.("release");
      yield* Effect.all([writer.wait("finished"), logout.wait("finished")], {
        concurrency: "unbounded",
      });
      expect(
        yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "credential.json"))).pipe(
          Effect.isFailure,
        ),
      ).toBe(true);
      const access = yield* launch(directory, "access");
      yield* access.wait("failed");
    }).pipe(Effect.scoped),
  30_000,
);

it.live(
  "recovers a dead refresh owner but rejects the durable quarantine until sign-in",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      yield* run(directory, "seed");
      const first = yield* launch(directory, "refresh-hold");
      yield* first.wait("refresh-started");
      yield* kill(first.child);
      const second = yield* launch(directory, "access");
      yield* second.wait("failed");
      expect(
        yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "refreshes"), "utf8")),
      ).toBe("refresh\n");
      yield* run(directory, "logout");
    }).pipe(Effect.scoped),
  30_000,
);

it.live(
  "cancels a native waiter promptly but holds cross-process logout until real settlement",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const writer = yield* launch(directory, "write-cancel");
      yield* writer.wait("native-started");
      writer.child.send?.("cancel");
      yield* writer.wait("cancelled").pipe(Effect.timeout("1 second"));
      const logout = yield* launch(directory, "logout");
      yield* logout.wait("attempting");
      yield* Effect.sleep(100);
      expect(logout.messages).not.toContain("deleted");
      writer.child.send?.("release");
      yield* writer.wait("native-completed");
      yield* logout.wait("finished");
      expect(
        yield* Effect.tryPromise(() => fs.readFile(path.join(directory, "credential.json"))).pipe(
          Effect.isFailure,
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  30_000,
);

it.live(
  "withdraws trust while waiting for another process without reading or refreshing its grant",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      yield* run(directory, "seed");
      const first = yield* launch(directory, "refresh-hold");
      yield* first.wait("refresh-started");
      const second = yield* launch(directory, "access-trust");
      yield* second.wait("attempting");
      second.child.send?.("revoke");
      yield* second.wait("failed").pipe(Effect.timeout("1 second"));
      expect(second.messages).not.toContain("native-read");
      expect(second.messages).not.toContain("refresh-started");
      first.child.send?.("release");
      yield* first.wait("finished");
    }).pipe(Effect.scoped),
  30_000,
);

it.live(
  "fails closed after death during a native mutation, including logout",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const first = yield* launch(directory, "write-hold");
      yield* first.wait("native-started");
      yield* kill(first.child);
      const logout = yield* launch(directory, "logout");
      yield* logout.wait("failed");
      expect(logout.messages).not.toContain("deleted");
    }).pipe(Effect.scoped),
  30_000,
);

it.live(
  "many normal credential transactions do not grow the private lock directory",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      let value: string | undefined;
      const entryFactory: KeychainEntryFactory = () =>
        Promise.resolve({
          getPassword: () => Promise.resolve(value),
          setPassword: (next) => {
            value = next;
            return Promise.resolve();
          },
          deleteCredential: () => {
            value = undefined;
            return Promise.resolve(true);
          },
        });
      const store = yield* McpCredentialStore.pipe(
        Effect.provide(
          McpCredentialStore.layer({
            entryFactory,
            lockDirectory: directory,
          }),
        ),
      );
      const identity = "f".repeat(64);
      for (let index = 0; index < 40; index++) {
        yield* store.withTransaction(identity, (tx) =>
          Effect.gen(function* () {
            yield* tx.writeRegistration({
              identity,
              issuer: "https://issuer.example",
              resource: "https://resource.example",
              registration: "dynamic",
              redirectUri: "http://127.0.0.1/callback",
              clientInformation: { client_id: "fixture" },
              scopes: [],
            });
            expect(yield* tx.readRegistration).toBeDefined();
            yield* tx.remove;
          }),
        );
      }
      expect(value).toBeUndefined();
      expect(yield* Effect.tryPromise(() => fs.readdir(directory))).toEqual([]);
    }).pipe(Effect.scoped),
  15_000,
);
