import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import { decodeRpcEnvelope, type RpcResponse } from "../src/backend/local-pi-protocol.ts";
import { describe, expect, it } from "@effect/vitest";
import { nodeFsPromises as fs, nodePath as path, nodeSpawn } from "./support/node-builtins.ts";

class RpcFixtureError extends Data.TaggedError("RpcFixtureError")<{ readonly message: string }> {}

describe("installed Pi RPC input hooks", () => {
  it.live(
    "transforms and handles steer/follow_up through source rpc without credentials or inference",
    () =>
      Effect.gen(function* () {
        const temporaryRoot = yield* Config.String("TMPDIR").pipe(Config.withDefault("/tmp"));
        const executablePath = yield* Config.String("PATH").pipe(Config.withDefault(""));
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(temporaryRoot, "pi-rpc-input-"))),
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        );
        const exited = yield* Deferred.make<void>();
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const child = nodeSpawn(
              process.execPath,
              [
                path.join(getPackageDir(), "dist/bundle/cli.js"),
                "--mode",
                "rpc",
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
                "--no-themes",
                "--no-tools",
                "-e",
                fileURLToPath(new URL("./fixtures/pi-rpc-input-extension.ts", import.meta.url)),
              ],
              {
                cwd: directory,
                env: {
                  HOME: directory,
                  PATH: executablePath,
                  PI_CODING_AGENT_DIR: directory,
                  PI_OFFLINE: "1",
                },
                stdio: ["pipe", "pipe", "pipe"],
              },
            );
            child.once("close", () => Deferred.doneUnsafe(exited, Effect.void));
            return child;
          }),
          (child) =>
            Effect.gen(function* () {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              yield* Deferred.await(exited);
            }),
        );
        let stderr = "";
        let buffer = "";
        let nextId = 0;
        const runCallback = Effect.runSyncWith(yield* Effect.context<never>());
        const pending = new Map<
          string,
          { resolve: (value: RpcResponse) => void; reject: (error: RpcFixtureError) => void }
        >();
        const fail = (error: RpcFixtureError) => {
          for (const waiter of pending.values()) waiter.reject(error);
          pending.clear();
        };
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-8_192);
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 1_048_576) {
            fail(new RpcFixtureError({ message: "RPC fixture output exceeded limit" }));
            child.kill("SIGKILL");
            return;
          }
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const value = runCallback(
                Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(
                  Effect.flatMap(decodeRpcEnvelope),
                ),
              );
              if (value.type !== "response" || value.id === undefined) continue;
              const waiter = pending.get(value.id);
              if (!waiter) continue;
              pending.delete(value.id);
              waiter.resolve(value);
            } catch (error) {
              fail(
                new RpcFixtureError({ message: `Invalid RPC fixture output: ${String(error)}` }),
              );
            }
          }
        });
        child.once("close", () =>
          fail(new RpcFixtureError({ message: `RPC fixture exited: ${stderr}` })),
        );
        child.on("error", (error) => fail(new RpcFixtureError({ message: error.message })));
        const request = (type: string, message?: string) =>
          Effect.callback<RpcResponse, RpcFixtureError>((resume) => {
            const resolve = (value: RpcResponse) => resume(Effect.succeed(value));
            const reject = (error: RpcFixtureError) => resume(Effect.fail(error));
            const id = String(++nextId);
            pending.set(id, { resolve, reject });
            child.stdin.write(
              Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ id, type, message }) +
                "\n",
              (error) => {
                if (error) {
                  pending.delete(id);
                  reject(new RpcFixtureError({ message: error.message }));
                }
              },
            );
            return Effect.sync(() => {
              pending.delete(id);
            });
          });
        yield* Effect.gen(function* () {
          expect(yield* request("get_state")).toMatchObject({ success: true });
          expect(yield* request("steer", "handled")).toMatchObject({ success: true });
          expect(yield* request("follow_up", "handled")).toMatchObject({ success: true });
          expect(yield* request("steer", "steering\u2028payload")).toMatchObject({ success: true });
          expect(yield* request("follow_up", "next\u2029payload")).toMatchObject({ success: true });
          expect(yield* request("clear_queue")).toMatchObject({
            success: true,
            data: {
              // Idle queue commands still carry rpc source, but are not mid-stream inputs.
              steering: ["rpc:undefined:steering\u2028payload"],
              followUp: ["rpc:undefined:next\u2029payload"],
            },
          });
          expect(yield* request("get_messages")).toMatchObject({
            success: true,
            data: { messages: [] },
          });
          expect(yield* request("prompt", "/fixture-shutdown")).toMatchObject({ success: true });
          yield* Deferred.await(exited);
        }).pipe(Effect.timeout("25 seconds"));
      }),
    30_000,
  );
});
