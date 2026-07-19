import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./utils.ts";

export const AUTH_FILE = join(getAgentDir(), "auth.json");
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

export type XaiCredentials = {
  accessToken: string;
  refreshToken?: string;
  expires?: number;
  teamId?: string;
};

export type XaiCredentialsWithSource = XaiCredentials & {
  source: "modelRegistry" | "authFile";
};

type XaiAuthEntry = {
  type?: string;
  access?: string | null;
  refresh?: string | null;
  expires?: number | null;
};

function waitForSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation was aborted."));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Operation was aborted."));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

export function extractTeamIdFromJwt(token: string): string | undefined {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    const parsed = JSON.parse(decodeBase64Url(payload)) as unknown;
    if (!isRecord(parsed)) return undefined;
    const teamId = parsed.team_id;
    return typeof teamId === "string" && teamId.trim() ? teamId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readAuthFile(): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseXaiAuthEntry(entry: unknown): XaiCredentials | undefined {
  if (!isRecord(entry) || entry.type !== "oauth") return undefined;
  const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
  if (!accessToken) return undefined;
  const refreshToken =
    typeof entry.refresh === "string" && entry.refresh.trim() ? entry.refresh.trim() : undefined;
  const expires = typeof entry.expires === "number" ? entry.expires : undefined;
  return {
    accessToken,
    refreshToken,
    expires,
    teamId: extractTeamIdFromJwt(accessToken),
  };
}

export function readXaiAuth(now = Date.now()): XaiCredentials | undefined {
  const auth = readAuthFile();
  if (!auth) return undefined;
  const credentials = parseXaiAuthEntry(auth.xai);
  if (!credentials) return undefined;
  if (typeof credentials.expires === "number" && now >= credentials.expires) {
    // Keep expired entries so callers can refresh with the stored refresh token.
    return credentials;
  }
  return credentials;
}

function writeXaiAuth(entry: XaiAuthEntry): void {
  const auth = readAuthFile() ?? {};
  const previous = isRecord(auth.xai) ? auth.xai : {};
  auth.xai = {
    ...previous,
    type: "oauth",
    access: entry.access,
    refresh: entry.refresh ?? previous.refresh ?? null,
    expires: entry.expires ?? null,
  };
  writeFileSync(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

async function refreshXaiToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<XaiCredentials> {
  const response = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    const description =
      isRecord(body) && typeof body.error_description === "string"
        ? body.error_description
        : undefined;
    const detail = [error, description].filter(Boolean).join(": ");
    throw new Error(
      `xAI OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token.trim()) {
    throw new Error("xAI OAuth token refresh returned an invalid payload.");
  }
  const accessToken = body.access_token.trim();
  const nextRefresh =
    typeof body.refresh_token === "string" && body.refresh_token.trim()
      ? body.refresh_token.trim()
      : refreshToken;
  const expiresInSeconds =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_TOKEN_LIFETIME_SECONDS;
  const expires = Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS;
  writeXaiAuth({
    access: accessToken,
    refresh: nextRefresh,
    expires,
  });
  return {
    accessToken,
    refreshToken: nextRefresh,
    expires,
    teamId: extractTeamIdFromJwt(accessToken),
  };
}

export async function getXaiCredentials(
  ctx?: Pick<ExtensionContext, "modelRegistry">,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<XaiCredentialsWithSource | undefined> {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation was aborted.");

  const auth = readXaiAuth(now);
  if (auth?.refreshToken && (auth.expires === undefined || now >= auth.expires - REFRESH_SKEW_MS)) {
    try {
      const refreshed = await refreshXaiToken(auth.refreshToken, signal);
      return { ...refreshed, source: "authFile" };
    } catch {
      // Fall through to registry / existing access token.
    }
  }

  const registryRequest = ctx?.modelRegistry?.getApiKeyForProvider("xai");
  const registryToken = registryRequest
    ? await waitForSignal(
        registryRequest.catch(() => undefined),
        signal,
      )
    : undefined;
  const registryAccess = registryToken?.trim();
  if (registryAccess) {
    return {
      accessToken: registryAccess,
      teamId: extractTeamIdFromJwt(registryAccess),
      source: "modelRegistry",
    };
  }

  if (auth?.accessToken && (auth.expires === undefined || now < auth.expires)) {
    return { ...auth, source: "authFile" };
  }
  return undefined;
}
