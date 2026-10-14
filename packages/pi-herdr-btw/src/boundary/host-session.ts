import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { captureSessionHost } from "pi-cosmic-core";

export interface HerdrBtwSessionInput {
  readonly cwd: string;
  readonly sessionFile?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionDir?: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

export const captureHerdrBtwSession = (ctx: ExtensionContext) => {
  const host = captureSessionHost(ctx);
  if (!Predicate.isTagged(host, "Captured")) return undefined;
  try {
    return {
      cwd: host.cwd,
      signal: host.signal,
      aborted: host.aborted,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionDir: ctx.sessionManager.getSessionDir(),
      environment: process.env,
    };
  } catch {
    return undefined;
  }
};
