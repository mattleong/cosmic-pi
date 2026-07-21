import { access, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const coreDist = join(root, "packages/pi-cosmic-core/dist");
const temporary = await mkdtemp(join(tmpdir(), "cosmic-pi-local-advisor-"));
const backup = join(temporary, "core-dist");
const hadDist = await access(coreDist).then(
  () => true,
  () => false,
);

function run(command, args, failure) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${failure}:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
}

try {
  if (hadDist) await rename(coreDist, backup);

  run("pnpm", ["prepare"], "pnpm prepare failed");
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const extension = await import('./packages/pi-advisor/index.ts'); if (typeof extension.default !== 'function') throw new Error('missing advisor extension');",
    ],
    "local advisor import failed",
  );
  console.log("Local advisor imports after prepare builds core from a dist-free workspace.");
} finally {
  await rm(coreDist, { recursive: true, force: true });
  if (hadDist) await rename(backup, coreDist);
  await rm(temporary, { recursive: true, force: true });
}
