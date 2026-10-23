import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import type * as Cause from "effect/Cause";
import { decodeRpcEnvelope, type RpcResponse } from "../src/backend/local-pi-protocol.ts";
import { localPiBackendDriver } from "../src/backend/local-pi.ts";
import type { ChildWireEvent } from "../src/boundary/child-process.ts";
import type { ProcessExit } from "../src/boundary/process-transport.ts";
import { SubagentProcessError } from "../src/run/errors.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";
import { describe, expect, it } from "@effect/vitest";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { nodePath as path, nodeSpawn } from "./support/node-builtins.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

class RpcFixtureError extends Schema.TaggedError<
  RpcFixtureError,
  { readonly brand: unique symbol }
>()("RpcFixtureError", {
  message: Schema.String,
}) {}

interface RpcCommand {
  readonly type: string;
  readonly message?: string;
  readonly streamingBehavior?: "steer" | "followUp";
}

const rpcFixture = (extension: string, extraArgs: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const executablePath = yield* Config.String("PATH").pipe(Config.withDefault(""));
    const directory = yield* temporaryDirectory("pi-rpc-input-");
    const exited = yield* Deferred.make<void>();
    const exitReceipt = yield* Deferred.make<ProcessExit>();
    const backendEvents = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
    let stderr = "";
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const spawned = nodeSpawn(
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
            ...extraArgs,
            "-e",
            fileURLToPath(new URL(`./fixtures/${extension}`, import.meta.url)),
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
        spawned.once("close", (exitCode, signal) => {
          Deferred.doneUnsafe(exited, Effect.void);
          Deferred.doneUnsafe(
            exitReceipt,
            Effect.succeed({ exitCode, ...(signal && { signal }), stderr }),
          );
          Queue.endUnsafe(backendEvents);
        });
        return spawned;
      }),
      (running) =>
        Effect.gen(function* () {
          if (running.exitCode === null && running.signalCode === null) running.kill("SIGKILL");
          yield* Deferred.await(exited);
        }),
    );
    let buffer = "";
    let nextId = 0;
    const eventTypes: string[] = [];
    const runCallback = Effect.runSyncWith(yield* Effect.context());
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
          const frame = runCallback(decodeJson(line));
          Queue.offerUnsafe(backendEvents, { type: "rpc_message", value: frame });
          const value = runCallback(decodeRpcEnvelope(frame));
          if (value.type !== "response") {
            eventTypes.push(value.type === "ignored" ? value.eventType : value.type);
            continue;
          }
          if (value.id === undefined) continue;
          const waiter = pending.get(value.id);
          if (!waiter) continue;
          pending.delete(value.id);
          waiter.resolve(value);
        } catch (error) {
          fail(new RpcFixtureError({ message: `Invalid RPC fixture output: ${String(error)}` }));
        }
      }
    });
    child.once("close", () =>
      fail(new RpcFixtureError({ message: `RPC fixture exited: ${stderr}` })),
    );
    child.on("error", (error) => fail(new RpcFixtureError({ message: error.message })));
    const request = (command: RpcCommand) =>
      Effect.callback<RpcResponse, RpcFixtureError>((resume) => {
        const resolve = (value: RpcResponse) => resume(Effect.succeed(value));
        const reject = (error: RpcFixtureError) => resume(Effect.fail(error));
        const id = String(++nextId);
        pending.set(id, { resolve, reject });
        child.stdin.write(`${encodeJson({ id, ...command })}\n`, (error) => {
          if (error) {
            pending.delete(id);
            reject(new RpcFixtureError({ message: error.message }));
          }
        });
        return Effect.sync(() => {
          pending.delete(id);
        });
      });
    const count = (type: string) => eventTypes.filter((eventType) => eventType === type).length;
    const driver = localPiBackendDriver({
      reclaimRunState: () => Effect.void,
      spawn: () =>
        Effect.succeed({
          pid: child.pid ?? 0,
          events: backendEvents,
          awaitExit: Deferred.await(exitReceipt),
          acknowledge: () => {},
          send: (command) =>
            Effect.callback<void, SubagentProcessError>((resume) => {
              child.stdin.write(`${encodeJson(command)}\n`, (error) =>
                resume(
                  error
                    ? Effect.fail(
                        new SubagentProcessError({
                          operation: "send fixture command to",
                          message: "RPC fixture command could not be sent.",
                        }),
                      )
                    : Effect.void,
                ),
              );
            }),
          sendContactControl: () => Effect.void,
          terminate: () => Effect.sync(() => void child.kill("SIGKILL")),
        }),
    });
    return {
      request,
      count,
      exited,
      spawnBackend: driver.spawn(backendLaunch()),
    };
  });

describe("installed Pi RPC input hooks", () => {
  it.live(
    "rejects a handled task through the local backend rather than waiting for a nonexistent run",
    () =>
      Effect.gen(function* () {
        const pi = yield* rpcFixture("pi-rpc-input-extension.ts");
        const backend = yield* pi.spawnBackend;
        yield* Effect.gen(function* () {
          yield* backend.controls.initialize;
          expect(yield* backend.controls.start("handled", 1).pipe(Effect.flip)).toMatchObject({
            code: "prompt_not_delivered",
          });
          expect(yield* backend.controls.steer("handled").pipe(Effect.flip)).toMatchObject({
            code: "guidance_not_delivered",
          });
          // A subsequent RPC response establishes that Pi processed the handled task. It did not
          // publish an assignment lifecycle for either input.
          yield* pi.request({ type: "get_state" });
          expect(pi.count("agent_start")).toBe(0);
          expect(pi.count("agent_settled")).toBe(0);
          expect(
            yield* backend.controls.start("/fixture-shutdown", 2).pipe(Effect.flip),
          ).toMatchObject({ code: "prompt_not_delivered" });
          yield* Deferred.await(pi.exited);
        }).pipe(Effect.timeout("25 seconds"));
      }),
    30_000,
  );
});
