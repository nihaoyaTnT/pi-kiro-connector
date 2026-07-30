import { randomUUID } from "node:crypto";
import type {
  AuthInteraction,
  FetchFunction,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { type KiroBuilderIdCredential, isBuilderIdCredential } from "./auth.ts";
import {
  builderIdProfilesUrl,
  DEFAULT_REGION,
  kiroUserAgentForMachineId,
  normalizeProfileArn,
  normalizeRegion,
  oidcUrl,
} from "./config.ts";

const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const PROFILE_REGIONS = [DEFAULT_REGION, "eu-central-1"] as const;
const MAX_PROFILE_PAGES = 20;
const SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
] as const;

interface RegisteredClient {
  clientId: string;
  clientSecret: string;
}

interface DeviceAuthorization extends RegisteredClient {
  authRegion: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

interface TokenResponse {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresIn?: unknown;
  profileArn?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function verificationUrl(value: string, authRegion: string): string {
  const url = new URL(value);
  const allowedHosts = new Set([
    `device.sso.${authRegion}.amazonaws.com`,
    "view.awsapps.com",
  ]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error("Kiro Builder ID returned an invalid verification URL");
  }
  return url.toString();
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value.replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result.length > 500 ? `${result.slice(0, 500)}…` : result;
}

async function responseJson(
  response: Response,
  action: string,
  secrets: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${action} failed (HTTP ${response.status})${body ? `: ${redact(body, secrets)}` : ""}`,
    );
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${action} returned an invalid JSON response`);
  }
}

async function postJson(
  url: string,
  payload: Record<string, unknown>,
  input: {
    fetch?: FetchFunction;
    signal?: AbortSignal;
    action: string;
    secrets?: readonly string[];
  },
): Promise<Record<string, unknown>> {
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: input.signal,
  });
  return responseJson(response, input.action, input.secrets);
}

export async function startBuilderIdAuthorization(input: {
  region?: string;
  signal?: AbortSignal;
  fetch?: FetchFunction;
} = {}): Promise<DeviceAuthorization> {
  const authRegion = normalizeRegion(input.region ?? DEFAULT_REGION);
  const registered = await postJson(
    oidcUrl(authRegion, "client/register"),
    {
      clientName: "Kiro",
      clientType: "public",
      scopes: SCOPES,
      grantTypes: [DEVICE_GRANT, "refresh_token"],
      issuerUrl: BUILDER_ID_START_URL,
    },
    { fetch: input.fetch, signal: input.signal, action: "Kiro Builder ID client registration" },
  );
  const clientId = text(registered.clientId);
  const clientSecret = text(registered.clientSecret);
  if (!clientId || !clientSecret) throw new Error("Kiro Builder ID registration omitted client credentials");

  const authorized = await postJson(
    oidcUrl(authRegion, "device_authorization"),
    { clientId, clientSecret, startUrl: BUILDER_ID_START_URL },
    {
      fetch: input.fetch,
      signal: input.signal,
      action: "Kiro Builder ID device authorization",
      secrets: [clientId, clientSecret],
    },
  );
  const deviceCode = text(authorized.deviceCode);
  const userCode = text(authorized.userCode);
  const rawVerificationUri = text(authorized.verificationUriComplete) ?? text(authorized.verificationUri);
  if (!deviceCode || !userCode || !rawVerificationUri) {
    throw new Error("Kiro Builder ID device authorization returned incomplete data");
  }
  return {
    authRegion,
    clientId,
    clientSecret,
    deviceCode,
    userCode,
    verificationUri: verificationUrl(rawVerificationUri, authRegion),
    intervalSeconds: positiveSeconds(authorized.interval, 5),
    expiresInSeconds: positiveSeconds(authorized.expiresIn, 600),
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Login cancelled"));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function discoverBuilderIdProfile(input: {
  accessToken: string;
  machineId: string;
  signal?: AbortSignal;
  fetch?: FetchFunction;
}): Promise<string | undefined> {
  const agent = kiroUserAgentForMachineId(input.machineId, false);
  for (const region of PROFILE_REGIONS) {
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PROFILE_PAGES; page++) {
      try {
        const response = await (input.fetch ?? globalThis.fetch)(builderIdProfilesUrl(region), {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${input.accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": agent.userAgent,
            "x-amz-user-agent": agent.amzUserAgent,
            "x-amzn-codewhisperer-optout": "true",
          },
          body: JSON.stringify({ maxResults: 50, ...(nextToken ? { nextToken } : {}) }),
          signal: input.signal,
        });
        const body = await response.text();
        if (!response.ok) {
          if (
            response.status === 403 &&
            body.includes("AWS Builder ID is not supported for this operation")
          ) {
            return undefined;
          }
          break;
        }
        const parsed = JSON.parse(body) as { profiles?: unknown; nextToken?: unknown };
        if (!Array.isArray(parsed.profiles)) break;
        for (const profile of parsed.profiles) {
          if (!profile || typeof profile !== "object") continue;
          const arn = text((profile as { arn?: unknown }).arn);
          if (!arn) continue;
          try {
            return normalizeProfileArn(arn);
          } catch {
            // Ignore malformed account metadata and inspect the remaining profiles.
          }
        }
        nextToken = text(parsed.nextToken);
        if (!nextToken) break;
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason ?? error;
        break;
      }
    }
  }
  return undefined;
}

async function requestDeviceToken(
  authorization: DeviceAuthorization,
  input: { signal?: AbortSignal; fetch?: FetchFunction },
): Promise<TokenResponse> {
  const response = await (input.fetch ?? globalThis.fetch)(oidcUrl(authorization.authRegion, "token"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: authorization.clientId,
      clientSecret: authorization.clientSecret,
      grantType: DEVICE_GRANT,
      deviceCode: authorization.deviceCode,
    }),
    signal: input.signal,
  });
  const body = await response.text();
  let parsed: TokenResponse = {};
  try {
    parsed = JSON.parse(body) as TokenResponse;
  } catch {
    // The bounded, redacted body below is more useful than a JSON parser error.
  }
  if (response.ok) return parsed;
  const code = text(parsed.error);
  if (response.status === 400 && code) return parsed;
  throw new Error(
    `Kiro Builder ID token request failed (HTTP ${response.status})${body
      ? `: ${redact(body, [authorization.clientId, authorization.clientSecret, authorization.deviceCode])}`
      : ""}`,
  );
}

export async function completeBuilderIdAuthorization(
  authorization: DeviceAuthorization,
  input: { signal?: AbortSignal; fetch?: FetchFunction } = {},
): Promise<KiroBuilderIdCredential> {
  const deadline = Date.now() + authorization.expiresInSeconds * 1000;
  let intervalSeconds = authorization.intervalSeconds;
  while (Date.now() < deadline) {
    const token = await requestDeviceToken(authorization, input);
    const access = text(token.accessToken);
    const refresh = text(token.refreshToken);
    if (access && refresh) {
      const machineId = randomUUID();
      const responseProfileArn = text(token.profileArn);
      const profileArn = responseProfileArn
        ? normalizeProfileArn(responseProfileArn)
        : await discoverBuilderIdProfile({
            accessToken: access,
            machineId,
            signal: input.signal,
            fetch: input.fetch,
          });
      return {
        type: "oauth",
        access,
        refresh,
        expires: Date.now() + positiveSeconds(token.expiresIn, 3600) * 1000,
        authRegion: authorization.authRegion,
        clientId: authorization.clientId,
        clientSecret: authorization.clientSecret,
        machineId,
        identityProvider: "builder_id",
        ...(profileArn ? { profileArn } : {}),
      };
    }

    const code = text(token.error);
    if (!code) throw new Error("Kiro Builder ID token response omitted required tokens");
    if (code === "slow_down") intervalSeconds += 5;
    else if (code === "access_denied") throw new Error("Kiro Builder ID authorization was denied");
    else if (code === "expired_token") throw new Error("Kiro Builder ID device code expired");
    else if (code !== "authorization_pending") {
      const description = text(token.error_description);
      const detail = `${code}${description ? ` (${description})` : ""}`;
      throw new Error(
        `Kiro Builder ID authorization failed: ${redact(detail, [
          authorization.clientId,
          authorization.clientSecret,
          authorization.deviceCode,
        ])}`,
      );
    }
    await wait(intervalSeconds * 1000, input.signal);
  }
  throw new Error("Kiro Builder ID device authorization expired");
}

export async function loginBuilderId(interaction: AuthInteraction): Promise<KiroBuilderIdCredential> {
  interaction.notify({ type: "progress", message: "Starting Kiro Builder ID sign-in…" });
  const authorization = await startBuilderIdAuthorization({ signal: interaction.signal });
  interaction.notify({
    type: "device_code",
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    intervalSeconds: authorization.intervalSeconds,
    expiresInSeconds: authorization.expiresInSeconds,
  });
  const credential = await completeBuilderIdAuthorization(authorization, { signal: interaction.signal });
  interaction.notify({ type: "info", message: "Kiro Builder ID sign-in completed." });
  return credential;
}

export async function refreshBuilderId(
  credential: OAuthCredential,
  signal?: AbortSignal,
  fetch?: FetchFunction,
): Promise<KiroBuilderIdCredential> {
  if (!isBuilderIdCredential(credential)) throw new Error("Invalid Kiro Builder ID credential metadata");
  const response = await postJson(
    oidcUrl(credential.authRegion, "token"),
    {
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      refreshToken: credential.refresh,
      grantType: "refresh_token",
    },
    {
      fetch,
      signal,
      action: "Kiro Builder ID token refresh",
      secrets: [credential.clientId, credential.clientSecret, credential.refresh, credential.access],
    },
  );
  const access = text(response.accessToken);
  if (!access) throw new Error("Kiro Builder ID token refresh omitted the access token");
  const refresh = text(response.refreshToken) ?? credential.refresh;
  const responseProfileArn = text(response.profileArn);
  const profileArn = responseProfileArn
    ? normalizeProfileArn(responseProfileArn)
    : credential.profileArn
      ? normalizeProfileArn(credential.profileArn)
      : await discoverBuilderIdProfile({
          accessToken: access,
          machineId: credential.machineId,
          signal,
          fetch,
        });
  return {
    ...credential,
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + positiveSeconds(response.expiresIn, 3600) * 1000,
    ...(profileArn ? { profileArn } : {}),
  };
}
