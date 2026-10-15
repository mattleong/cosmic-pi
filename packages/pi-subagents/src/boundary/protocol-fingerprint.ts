import { VERSION } from "@earendil-works/pi-coding-agent";
import { sha256Text } from "pi-cosmic-core";
import { fileURLToPath } from "node:url";
import { nodeCreateHash, nodeReadFileSync } from "./node-builtins.ts";

export const PROTOCOL_FINGERPRINT_ENV = "PI_SUBAGENT_PROTOCOL";

// The modules that define what crosses the root-child boundary. A child Pi loads this package from
// disk when it starts, so after an update mid-session the two sides can disagree about these.
const PROTOCOL_MODULES = [
  "./local-pi-ipc.ts",
  "../backend/local-pi-protocol.ts",
  "../tools/proxy-protocol.ts",
  "../tools/schema.ts",
  "../tools/contract-schema.ts",
  "../tools/details-schema.ts",
] as const;

let modulesDigest: string | undefined;

const protocolModulesDigest = (): string => {
  if (modulesDigest !== undefined) return modulesDigest;
  const hash = nodeCreateHash("sha256");
  for (const module of PROTOCOL_MODULES)
    hash.update(nodeReadFileSync(fileURLToPath(new URL(module, import.meta.url))));
  modulesDigest = hash.digest("hex");
  return modulesDigest;
};

/**
 * A short hash of the protocol modules and the Pi version this process loaded. Children run Pi's
 * installed CLI, so after `pi update` mid-session they run a newer Pi than their parent.
 */
export const protocolFingerprint = (piVersion = VERSION): string =>
  sha256Text(`${piVersion}\n${protocolModulesDigest()}`).slice(0, 16);

/** Why a child must not run, when the parent that started it loaded different protocol code. */
export const protocolMismatch = (environment: Readonly<NodeJS.ProcessEnv>): string | undefined => {
  const expected = environment[PROTOCOL_FINGERPRINT_ENV];
  if (expected === undefined || expected === protocolFingerprint()) return undefined;
  return "Pi or pi-subagents changed on disk since this Pi session started, so the subagent no longer matches its parent. Restart Pi to load one version.";
};
