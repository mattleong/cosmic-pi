import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const expectedEffectVersion = /\n  effect: ([^\n]+)/.exec(workspace)?.[1];
if (!expectedEffectVersion) throw new Error("Missing Effect version from the pnpm catalog.");
const coreManifest = JSON.parse(
  await readFile(join(root, "packages/pi-cosmic-core/package.json"), "utf8"),
);
const xaiManifest = JSON.parse(
  await readFile(join(root, "packages/pi-better-xai/package.json"), "utf8"),
);
const piVersion = coreManifest.devDependencies["@earendil-works/pi-coding-agent"];
const tuiVersion = xaiManifest.peerDependencies["@earendil-works/pi-tui"];
const temporaryDirectory = await mkdtemp(join(tmpdir(), "cosmic-pi-pack-"));

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
  for (const packageName of ["pi-cosmic-core", "pi-better-xai"]) {
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", temporaryDirectory], root);
  }
  const tarballs = (await readdir(temporaryDirectory)).filter((name) => name.endsWith(".tgz"));
  const coreTarballName = tarballs.find((name) => name.startsWith("pi-cosmic-core-"));
  const xaiTarballName = tarballs.find((name) => name.startsWith("pi-better-xai-"));
  if (!coreTarballName || !xaiTarballName || tarballs.length !== 2) {
    throw new Error(`Expected core and xAI tarballs, found: ${tarballs.join(", ")}.`);
  }

  const coreTarball = join(temporaryDirectory, coreTarballName);
  const xaiTarball = join(temporaryDirectory, xaiTarballName);
  await writeFile(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "cosmic-pi-pack-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@earendil-works/pi-coding-agent": piVersion,
          "@earendil-works/pi-tui": tuiVersion,
          jiti: "2.7.0",
          "pi-better-xai": `file:${xaiTarball}`,
          "pi-cosmic-core": `file:${coreTarball}`,
        },
        pnpm: {
          overrides: {
            "pi-cosmic-core": `file:${coreTarball}`,
          },
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
      "const api = await import('pi-cosmic-core'); if (!api.PiApi || !api.makePiRuntime || !api.JsonDocumentStore || !api.JsonHttpClient || !api.nodePlatformLayer) throw new Error('missing core exports');",
    ],
    temporaryDirectory,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { createJiti } from 'jiti'; const api = await createJiti(import.meta.url).import('pi-better-xai'); if (typeof api.default !== 'function') throw new Error('missing xAI extension export');",
    ],
    temporaryDirectory,
  );

  const packedCoreManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-cosmic-core/package.json"), "utf8"),
  );
  if (
    packedCoreManifest.dependencies.effect !== expectedEffectVersion ||
    packedCoreManifest.dependencies["@effect/platform-node"] !== expectedEffectVersion
  ) {
    throw new Error("Packed pi-cosmic-core dependencies do not use the pinned Effect beta.");
  }
  const packedXaiManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-better-xai/package.json"), "utf8"),
  );
  if (
    packedXaiManifest.dependencies.effect !== expectedEffectVersion ||
    packedXaiManifest.dependencies["pi-cosmic-core"] !== coreManifest.version
  ) {
    throw new Error("Packed pi-better-xai dependencies are not synchronized.");
  }

  console.log("Packed core and xAI packages install and import in a clean consumer.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
