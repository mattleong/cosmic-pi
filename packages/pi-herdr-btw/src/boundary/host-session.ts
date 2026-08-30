// Pi session and inherited Herdr process state are captured at the host boundary.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureSessionHost } from "pi-cosmic-core";
import { selectHerdrEnvironment } from "./herdr-client.ts";
import { isRegularSessionFile } from "./session-file.ts";

const nodePath = process.getBuiltinModule("node:path");
if (!nodePath) throw new Error("Node path builtin is unavailable.");
const { basename } = nodePath;

export interface HerdrBtwSessionInput {
  readonly cwd: string;
  readonly sessionFile?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionDir?: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

interface CapturedHerdrBtwSession extends HerdrBtwSessionInput {
  readonly signal: AbortSignal | undefined;
  readonly aborted: boolean;
}

export const captureHerdrBtwSession = (
  ctx: ExtensionContext,
): CapturedHerdrBtwSession | undefined => {
  const host = captureSessionHost(ctx);
  if (host._tag === "Unavailable") return undefined;
  try {
    return {
      cwd: host.cwd,
      signal: host.signal,
      aborted: host.aborted,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionDir: ctx.sessionManager.getSessionDir(),
      environment: selectHerdrEnvironment(process.env),
    };
  } catch {
    return undefined;
  }
};

export const isValidParentSessionFile = isRegularSessionFile;

export const parentBtwDisplayName = (cwd: string): string => `BTW · ${basename(cwd) || "Pi"}`;
