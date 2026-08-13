import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti/static";

const root = resolve(import.meta.dirname, "..");

function run(command, args, failure) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${failure}:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
}

run("pnpm", ["prepare"], "pnpm prepare failed");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extension = await jiti.import(resolve(root, "packages/pi-advisor/index.ts"));
if (typeof extension.default !== "function") throw new Error("missing advisor extension");
console.log("Local advisor imports directly from TypeScript source through Pi's Jiti loader.");
