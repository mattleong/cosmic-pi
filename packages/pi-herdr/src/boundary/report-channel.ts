// Private report files and helper launch metadata are isolated at this Node boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomUUID:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AgentDirectory } from "pi-cosmic-core";
import { HerdrReportError } from "../herd/errors.ts";
import type { HerdrReport } from "../herd/model.ts";

const RUN_ID_PATTERN = /^herdr-[a-z0-9-]{1,80}$/;
const MAX_REPORT_BYTES = 48_000;
const MAX_REPORT_DOCUMENT_BYTES = 512 * 1024;

const ReportDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: Schema.String,
  receiptId: Schema.String,
  submittedAt: Schema.Number,
  status: Schema.Literals(["completed", "blocked", "failed"] as const),
  report: Schema.String,
  sha256: Schema.String,
});

export interface PreparedReportChannel {
  readonly runId: string;
  readonly agentName: string;
  readonly generation: string;
  readonly directory: string;
  readonly helperPath: string;
  readonly mcpConfigPath: string;
}

export interface ReportChannelShape {
  readonly prepare: Effect.Effect<PreparedReportChannel, HerdrReportError>;
  readonly read: (runId: string) => Effect.Effect<HerdrReport | undefined, HerdrReportError>;
  readonly remove: (runId: string) => Effect.Effect<void>;
}

export class ReportChannel extends Context.Service<ReportChannel, ReportChannelShape>()(
  "pi-herdr/boundary/report-channel/ReportChannel",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const agentDirectory = yield* AgentDirectory;
      const reportsRoot = join(agentDirectory, "herdr", "reports");
      const helperPath = fileURLToPath(new URL("./report-helper.mjs", import.meta.url));

      const channelError = (operation: string, code: string) =>
        new HerdrReportError({
          operation,
          code,
          message: `Unable to ${operation} the private Herdr report channel.`,
        });

      const prepare = Effect.tryPromise({
        try: async () => {
          const uuid = randomUUID().toLowerCase();
          const runId = `herdr-${uuid}`;
          const agentName = `pih-${uuid.replaceAll("-", "").slice(0, 16)}`;
          const directory = join(reportsRoot, runId);
          const mcpConfigPath = join(directory, "mcp.json");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const config = {
            mcpServers: {
              herdr_report: {
                type: "stdio",
                command: process.execPath,
                args: [helperPath],
                env: {
                  HERDR_RUN_ID: runId,
                  HERDR_REPORT_DIR: directory,
                },
              },
            },
          };
          const temporary = join(directory, `.mcp.${randomUUID()}.tmp`);
          await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(temporary, mcpConfigPath);
          return {
            runId,
            agentName,
            generation: runId,
            directory,
            helperPath,
            mcpConfigPath,
          } satisfies PreparedReportChannel;
        },
        catch: () => channelError("prepare", "report_channel_prepare_failed"),
      });

      const read: ReportChannelShape["read"] = (runId) => {
        if (!RUN_ID_PATTERN.test(runId))
          return Effect.fail(channelError("decode", "report_channel_invalid_run_id"));
        return Effect.tryPromise({
          try: async () => {
            try {
              const handle = await open(join(reportsRoot, runId, "report.json"), "r");
              try {
                const metadata = await handle.stat();
                if (metadata.size > MAX_REPORT_DOCUMENT_BYTES)
                  throw new Error("report document exceeds its bounded limit");
                const source = await handle.readFile({ encoding: "utf8" });
                return JSON.parse(source) as unknown;
              } finally {
                await handle.close();
              }
            } catch (error) {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
              )
                return undefined;
              throw error;
            }
          },
          catch: () => channelError("read", "report_channel_read_failed"),
        }).pipe(
          Effect.flatMap((value) => {
            if (value === undefined) return Effect.succeed(undefined);
            const decoded = Schema.decodeUnknownOption(ReportDocumentSchema, {
              onExcessProperty: "error",
            })(value);
            const digest = Option.isSome(decoded)
              ? createHash("sha256")
                  .update(`${decoded.value.status}\0${decoded.value.report}`)
                  .digest("hex")
              : undefined;
            if (
              Option.isNone(decoded) ||
              decoded.value.runId !== runId ||
              Buffer.byteLength(decoded.value.report, "utf8") > MAX_REPORT_BYTES ||
              decoded.value.sha256 !== digest
            )
              return Effect.fail(channelError("decode", "report_channel_invalid"));
            return Effect.succeed({
              generation: decoded.value.runId,
              status: decoded.value.status,
              report: decoded.value.report,
              submittedAt: decoded.value.submittedAt,
            } satisfies HerdrReport);
          }),
        );
      };

      const remove: ReportChannelShape["remove"] = (runId) => {
        if (!RUN_ID_PATTERN.test(runId)) return Effect.void;
        return Effect.tryPromise({
          try: () => rm(join(reportsRoot, runId), { recursive: true, force: true }),
          catch: () => channelError("remove", "report_channel_remove_failed"),
        }).pipe(Effect.catch(() => Effect.void));
      };

      return ReportChannel.of({ prepare, read, remove });
    }),
  );
}
