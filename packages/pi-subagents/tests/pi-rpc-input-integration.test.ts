import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import { decodeRpcEnvelope, type RpcResponse } from "../src/backend/local-pi-protocol.ts";
import { describe, expect, it } from "@effect/vitest";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { nodePath as path, nodeSpawn } from "./support/node-builtins.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

class RpcFixtureError extends Data.TaggedError("RpcFixtureError")<{ readonly message: string }> {}

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
        spawned.once("close", () => Deferred.doneUnsafe(exited, Effect.void));
        return spawned;
      }),
      (running) =>
        Effect.gen(function* () {
          if (running.exitCode === null && running.signalCode === null) running.kill("SIGKILL");
          yield* Deferred.await(exited);
        }),
    );
    let stderr = "";
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
          const value = runCallback(decodeJson(line).pipe(Effect.flatMap(decodeRpcEnvelope)));
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
    const awaitEventCount = (type: string, expected: number) =>
      Effect.promise(() =>
        vi.waitFor(() => expect(count(type)).toBeGreaterThanOrEqual(expected), {
          timeout: 10_000,
        }),
      );
    return { request, count, awaitEventCount, exited };
  });

describe("installed Pi RPC input hooks", () => {
  it.live(
    "transforms and handles steer/follow_up through source rpc without credentials or inference",
    () =>
      Effect.gen(function* () {
        const pi = yield* rpcFixture("pi-rpc-input-extension.ts");
        yield* Effect.gen(function* () {
          expect(yield* pi.request({ type: "get_state" })).toMatchObject({ success: true });
          expect(yield* pi.request({ type: "steer", message: "handled" })).toMatchObject({
            success: true,
          });
          expect(yield* pi.request({ type: "follow_up", message: "handled" })).toMatchObject({
            success: true,
          });
          expect(yield* pi.request({ type: "steer", message: "steering payload" })).toMatchObject({
            success: true,
          });
          expect(yield* pi.request({ type: "follow_up", message: "next payload" })).toMatchObject({
            success: true,
          });
          expect(yield* pi.request({ type: "clear_queue" })).toMatchObject({
            success: true,
            data: {
              steering: ["rpc:undefined:steering payload"],
              followUp: ["rpc:undefined:next payload"],
            },
          });
          expect(yield* pi.request({ type: "get_messages" })).toMatchObject({
            success: true,
            data: { messages: [] },
          });
          expect(yield* pi.request({ type: "prompt", message: "/fixture-shutdown" })).toMatchObject(
            { success: true },
          );
          yield* Deferred.await(pi.exited);
        }).pipe(Effect.timeout("25 seconds"));
      }),
    30_000,
  );

  it.live(
    "starts a turn for guidance sent as a steering prompt after the child settles",
    () =>
      Effect.gen(function* () {
        const pi = yield* rpcFixture("pi-rpc-faux-extension.ts");
        yield* Effect.gen(function* () {
          expect(yield* pi.request({ type: "prompt", message: "first task" })).toMatchObject({
            success: true,
            data: { disposition: "started" },
          });
          yield* pi.awaitEventCount("agent_settled", 1);

          // A bare steer after settlement is queued with no run to consume it.
          expect(yield* pi.request({ type: "steer", message: "lost guidance" })).toMatchObject({
            success: true,
            data: { disposition: "queued" },
          });
          expect(pi.count("agent_start")).toBe(1);
          yield* pi.request({ type: "clear_queue" });

          expect(
            yield* pi.request({
              type: "prompt",
              message: "late guidance",
              streamingBehavior: "steer",
            }),
          ).toMatchObject({ success: true, data: { disposition: "started" } });
          yield* pi.awaitEventCount("agent_settled", 2);
          expect(pi.count("agent_start")).toBe(2);
          const messages = yield* pi.request({ type: "get_messages" });
          const transcript = encodeJson(messages.data);
          expect(transcript).toContain("echo: late guidance");
          expect(transcript).not.toContain("echo: lost guidance");

          expect(yield* pi.request({ type: "prompt", message: "/fixture-shutdown" })).toMatchObject(
            { success: true },
          );
          yield* Deferred.await(pi.exited);
        }).pipe(Effect.timeout("25 seconds"));
      }),
    30_000,
  );
});
