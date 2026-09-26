#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const codexHome = process.env.CODEX_HOME;
await writeFile(join(codexHome, "fixture.pid"), String(process.pid));
process.on("SIGTERM", () => {});
let mode = "ok";
try {
  mode = (await readFile(join(codexHome, "fixture-mode"), "utf8")).trim() || "ok";
} catch {
  // Missing mode file selects the successful fixture contract.
}
let trusted = false;
const hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const changedHash = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

if (mode === "exit") process.exit(1);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (mode === "timeout") continue;
  if (mode === "malformed") {
    process.stdout.write("{not-json\n");
    continue;
  }
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    continue;
  }
  if (request.method === "initialized") continue;
  if (request.method === "hooks/list") {
    const hooksPath = join(codexHome, "hooks.json");
    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    const configured = hooks.hooks.SessionStart[0].hooks[0];
    const entry = {
      key: "opaque.future:key.with.dots/and:colons",
      eventName: "sessionStart",
      handlerType: "command",
      matcher: hooks.hooks.SessionStart[0].matcher ?? null,
      command: mode === "wrong-command" ? "foreign command" : configured.command,
      timeoutSec: configured.timeout ?? 600,
      statusMessage: null,
      additionalContextLimit: null,
      sourcePath: hooksPath,
      source: "user",
      pluginId: null,
      displayOrder: 0,
      enabled: mode !== "disabled",
      isManaged: false,
      currentHash: trusted && mode === "modified" ? changedHash : hash,
      trustStatus: trusted ? (mode === "modified" ? "modified" : "trusted") : "untrusted",
    };
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          data: [
            {
              cwd: request.params.cwds[0],
              hooks: mode === "extra" ? [entry, { ...entry, key: "foreign" }] : [entry],
              warnings: mode === "warning" ? ["fixture warning"] : [],
              errors: [],
            },
          ],
        },
      })}\n`,
    );
    continue;
  }
  if (request.method === "config/batchWrite") {
    const edit = request.params.edits?.[0];
    const state = edit?.value?.["opaque.future:key.with.dots/and:colons"];
    if (
      mode === "rejected" ||
      edit?.keyPath !== "hooks.state" ||
      edit?.mergeStrategy !== "upsert" ||
      state?.trusted_hash !== hash ||
      request.params.reloadUserConfig !== true
    ) {
      process.stdout.write(
        `${JSON.stringify({
          id: request.id,
          error: { code: -32600, message: "invalid trust request" },
        })}\n`,
      );
      continue;
    }
    trusted = true;
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          status: mode === "overridden" ? "okOverridden" : "ok",
          version: "fixture-version",
          filePath: join(codexHome, "config.toml"),
          overriddenMetadata: mode === "overridden" ? {} : null,
        },
      })}\n`,
    );
    continue;
  }
}
