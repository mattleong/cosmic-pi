#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import readline from "node:readline";

const [mode, pidPath] = process.argv.slice(2);
if (pidPath) await writeFile(pidPath, String(process.pid));

if (mode === "protocol-error") {
  process.on("SIGTERM", () => {});
  process.stdout.write("protocol-error\n");
} else if (mode === "echo" || mode === "delay-first") {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (mode === "delay-first" && request.id === "slow") return;
    process.stdout.write(`${JSON.stringify({ id: request.id, value: request.value })}\n`);
  });
} else if (mode === "no-read") {
  process.stdin.pause();
}

setInterval(() => {}, 1_000);
