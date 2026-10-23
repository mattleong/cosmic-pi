#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import * as Schema from "effect/Schema";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ request_id: Schema.String })),
);

createInterface({ input: process.stdin }).once("line", (line) => {
  const request = decodeRequest(line);
  const descendant = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  descendant.once("message", () => {
    writeFileSync(path.join(process.cwd(), "catalog-descendant.pid"), String(descendant.pid));
    process.stdout.write(
      `${JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: request.request_id,
          response: { models: [{ value: "default", resolvedModel: "fixture" }] },
        },
      })}\n`,
    );
  });
});
