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

let cached: string | undefined;

/** A short hash of the protocol modules this process loaded. */
export const protocolFingerprint = (): string => {
  if (cached !== undefined) return cached;
  const hash = nodeCreateHash("sha256");
  for (const module of PROTOCOL_MODULES)
    hash.update(nodeReadFileSync(fileURLToPath(new URL(module, import.meta.url))));
  cached = hash.digest("hex").slice(0, 16);
  return cached;
};

/** Why a child must not run, when the parent that started it loaded different protocol code. */
export const protocolMismatch = (environment: Readonly<NodeJS.ProcessEnv>): string | undefined => {
  const expected = environment[PROTOCOL_FINGERPRINT_ENV];
  if (expected === undefined || expected === protocolFingerprint()) return undefined;
  return "pi-subagents changed on disk since this Pi session started, so the subagent no longer matches its parent. Restart Pi to load one version.";
};
