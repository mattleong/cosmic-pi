#!/usr/bin/env node
import * as Schema from "effect/Schema";

const { spawn } = process.getBuiltinModule("node:child_process");
const { writeFileSync } = process.getBuiltinModule("node:fs");
const { createInterface } = process.getBuiltinModule("node:readline");
const path = process.getBuiltinModule("node:path");
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
