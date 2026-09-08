#!/usr/bin/env node
// A no-inference CLI stand-in that refuses unsafe catalog startup and reports the selector.
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (
  value("--setting-sources") !== "" ||
  value("--tools") !== "" ||
  value("--permission-mode") !== "dontAsk" ||
  !args.includes("--strict-mcp-config") ||
  JSON.parse(value("--settings")).disableAllHooks !== true ||
  Object.keys(JSON.parse(value("--mcp-config")).mcpServers).length !== 0 ||
  process.env.CLAUDE_CONFIG_DIR ||
  process.env.ANTHROPIC_API_KEY
)
  process.exit(2);
const selector = value("--model");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (selector === "reject") {
    process.stdout.write(
      `${JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: request.request_id,
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
        request_id: request.request_id,
        response: {
          models: [
            {
              value: "fixture-stable[1m]",
              resolvedModel: "fixture-stable",
              description: selector === "default" ? "Stable release" : "Updated stable metadata",
            },
            { value: selector, resolvedModel: "fixture-next", description: "Next release" },
          ],
        },
      },
    })}\n`,
  );
});
