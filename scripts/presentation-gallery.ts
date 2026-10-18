import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = join(import.meta.dirname, "..");
const packages = [
  "pi-code-previews",
  "pi-cosmic-ui",
  "pi-subagents",
  "pi-background-task",
  "pi-ask-user",
  "pi-better-openai",
  "pi-intercom",
];
const outIndex = process.argv.indexOf("--out");
const outArgument = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
const out = resolve(
  rootDir,
  outArgument === undefined || outArgument === "" ? "presentation-gallery.txt" : outArgument,
);

const directory = await mkdtemp(join(tmpdir(), "presentation-gallery-"));
try {
  for (const name of packages) {
    const run = spawnSync(
      "pnpm",
      ["--filter", name, "exec", "vitest", "run", "tests/presentation-gallery.test.ts"],
      {
        cwd: rootDir,
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, PRESENTATION_GALLERY: directory },
      },
    );
    if (run.status !== 0) {
      console.error(`Gallery for ${name} failed.`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) {
    const sections = await Promise.all(
      packages.map(
        async (name) =>
          `════ ${name} ════\n\n${await readFile(join(directory, `${name}.txt`), "utf8")}`,
      ),
    );
    await writeFile(out, sections.join("\n"));
    console.log(`Presentation gallery written to ${out}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
