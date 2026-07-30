// Node filesystem behavior is characterized at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
// @effect-diagnostics effect/strictEffectProvide:off
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { AgentDirectory } from "pi-cosmic-core";
import { afterEach, describe, expect } from "vitest";
import { ReportChannel } from "../src/boundary/report-channel.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ReportChannel", () => {
  it.effect("rejects traversal-shaped persisted run ids before reading or removing", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-herdr-channel-")));
      temporaryDirectories.push(directory);
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const reports = yield* ReportChannel;
          return yield* reports.read("../../outside");
        }).pipe(
          Effect.provide(ReportChannel.layer.pipe(Layer.provide(AgentDirectory.layer(directory)))),
        ),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
    }),
  );

  it.effect("rejects a report whose persisted digest does not match its contents", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pi-herdr-channel-")));
      temporaryDirectories.push(directory);
      const program = Effect.gen(function* () {
        const reports = yield* ReportChannel;
        const prepared = yield* reports.prepare;
        yield* Effect.promise(() =>
          writeFile(
            join(prepared.directory, "report.json"),
            JSON.stringify({
              schemaVersion: 1,
              runId: prepared.runId,
              receiptId: "receipt",
              submittedAt: 1,
              status: "completed",
              report: "tampered",
              sha256: "0".repeat(64),
            }),
          ),
        );
        return yield* Effect.exit(reports.read(prepared.runId));
      }).pipe(
        Effect.provide(ReportChannel.layer.pipe(Layer.provide(AgentDirectory.layer(directory)))),
      );
      const outcome = yield* program;
      expect(Exit.isFailure(outcome)).toBe(true);
    }),
  );
});
