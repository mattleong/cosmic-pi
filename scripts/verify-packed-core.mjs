import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const expectedEffectVersion = /\n  effect: ([^\n]+)/.exec(workspace)?.[1];
if (!expectedEffectVersion) throw new Error("Missing Effect version from the pnpm catalog.");
const sourceManifest = JSON.parse(
  await readFile(join(root, "packages/pi-cosmic-core/package.json"), "utf8"),
);
const piVersion = sourceManifest.devDependencies["@earendil-works/pi-coding-agent"];
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-cosmic-core-pack-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

try {
  run(
    "pnpm",
    ["--filter", "pi-cosmic-core", "pack", "--pack-destination", temporaryDirectory],
    root,
  );
  const tarballs = (await readdir(temporaryDirectory)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one pi-cosmic-core tarball, found ${tarballs.length}.`);
  }

  const tarball = join(temporaryDirectory, tarballs[0]);
  await writeFile(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "pi-cosmic-core-pack-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@earendil-works/pi-coding-agent": piVersion,
          "pi-cosmic-core": `file:${tarball}`,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  run(
    "pnpm",
    ["install", "--offline", "--ignore-scripts", "--config.engine-strict=true"],
    temporaryDirectory,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const api = await import('pi-cosmic-core'); if (!api.PiApi || !api.makePiRuntime) throw new Error('missing core exports');",
    ],
    temporaryDirectory,
  );

  const packedManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-cosmic-core/package.json"), "utf8"),
  );
  if (
    packedManifest.dependencies.effect !== expectedEffectVersion ||
    packedManifest.dependencies["@effect/platform-node"] !== expectedEffectVersion
  ) {
    throw new Error("Packed pi-cosmic-core dependencies do not use the pinned Effect beta.");
  }

  console.log("Packed pi-cosmic-core installs and imports successfully in a clean consumer.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
