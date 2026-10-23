#!/usr/bin/env node
import * as readline from "node:readline";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Rec from "effect/Record";

const decodeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ disableAllHooks: Schema.optionalKey(Schema.Json) })),
);
const decodeMcpConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Json) })),
);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ request_id: Schema.optionalKey(Schema.Json) })),
);
const configured = (name: string) =>
  Option.exists(Effect.runSync(Config.option(Config.String(name))), (value) => value !== "");
const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];
if (
  value("--setting-sources") !== "" ||
  value("--tools") !== "" ||
  value("--permission-mode") !== "dontAsk" ||
  !args.includes("--strict-mcp-config") ||
  decodeSettings(value("--settings")).disableAllHooks !== true ||
  !Rec.isEmptyRecord(decodeMcpConfig(value("--mcp-config")).mcpServers) ||
  configured("CLAUDE_CONFIG_DIR") ||
  configured("ANTHROPIC_API_KEY")
)
  process.exit(2);
const selector = value("--model");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const requestId = decodeRequest(line).request_id;
  if (selector === "reject") {
    process.stdout.write(
      `${JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: "private-provider-diagnostic",
        },
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          models:
            selector === "aliases"
              ? [
                  {
                    value: "default",
                    resolvedModel: "model-next",
                    displayName: "Default (recommended)",
                  },
                  { value: "opus", resolvedModel: "model-next", displayName: "Next" },
                  { value: "sonnet", resolvedModel: "model-fast", displayName: "Fast" },
                  { value: "model-older", resolvedModel: "model-older", displayName: "Older" },
                  { value: "legacy", resolvedModel: "model-older" },
                ]
              : [
                  {
                    value: "fixture-stable[1m]",
                    resolvedModel: "fixture-stable",
                    description:
                      selector === "default" ? "Stable release" : "Updated stable metadata",
                  },
                  {
                    value: selector,
                    resolvedModel: "fixture-next",
                    ...(selector === "default" && { displayName: "Default (recommended)" }),
                    description: "Next release",
                  },
                ],
        },
      },
    })}\n`,
  );
});
