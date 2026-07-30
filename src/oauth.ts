import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AuthInteraction,
  FetchFunction,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import {
  type KiroBuilderIdCredential,
  type KiroIdentityCenterCredential,
  type KiroOAuthCredential,
  isKiroOAuthCredential,
} from "./auth.ts";
import {
  builderIdProfilesUrl,
  DEFAULT_REGION,
  kiroUserAgentForMachineId,
  normalizeProfileArn,
  normalizeRegion,
  normalizeStartUrl,
  oidcUrl,
} from "./config.ts";

const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const IDENTITY_CENTER_REDIRECT_URI = "http://127.0.0.1/oauth/callback";
const DEFAULT_PROFILE_REGIONS = [DEFAULT_REGION, "eu-central-1"] as const;
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

export interface IdentityCenterAuthorization extends RegisteredClient {
  authRegion: string;
  startUrl: string;
  codeVerifier: string;
  state: string;
  authorizationUrl: string;
  expiresAt: number;
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

async function discoverAccountProfile(input: {
  accessToken: string;
  machineId: string;
  identityProvider: KiroOAuthCredential["identityProvider"];
  signal?: AbortSignal;
  fetch?: FetchFunction;
}): Promise<string | undefined> {
  const agent = kiroUserAgentForMachineId(input.machineId, false);
  for (const region of DEFAULT_PROFILE_REGIONS) {
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
            input.identityProvider === "builder_id" &&
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
        : await discoverAccountProfile({
            accessToken: access,
            machineId,
            identityProvider: "builder_id",
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

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function startIdentityCenterAuthorization(input: {
  startUrl: string;
  region: string;
  signal?: AbortSignal;
  fetch?: FetchFunction;
}): Promise<IdentityCenterAuthorization> {
  const authRegion = normalizeRegion(input.region);
  const startUrl = normalizeStartUrl(input.startUrl);
  const registered = await postJson(
    oidcUrl(authRegion, "client/register"),
    {
      clientName: "Kiro",
      clientType: "public",
      scopes: SCOPES,
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [IDENTITY_CENTER_REDIRECT_URI],
      issuerUrl: startUrl,
    },
    {
      fetch: input.fetch,
      signal: input.signal,
      action: "Kiro IAM Identity Center client registration",
      secrets: [startUrl],
    },
  );
  const clientId = text(registered.clientId);
  const clientSecret = text(registered.clientSecret);
  if (!clientId || !clientSecret) {
    throw new Error("Kiro IAM Identity Center registration omitted client credentials");
  }

  const codeVerifier = pkceVerifier();
  const state = randomUUID();
  const url = new URL(oidcUrl(authRegion, "authorize"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", IDENTITY_CENTER_REDIRECT_URI);
  url.searchParams.set("scopes", SCOPES.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return {
    authRegion,
    startUrl,
    clientId,
    clientSecret,
    codeVerifier,
    state,
    authorizationUrl: url.toString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
}

function identityCenterCallback(value: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Invalid IAM Identity Center callback URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/oauth/callback" ||
    url.hash
  ) {
    throw new Error("Invalid IAM Identity Center callback URL");
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== expectedState) {
    throw new Error("IAM Identity Center callback state did not match");
  }
  const errors = url.searchParams.getAll("error");
  if (errors.length > 1) throw new Error("Invalid IAM Identity Center callback URL");
  const callbackError = text(errors[0]);
  if (callbackError) {
    throw new Error("IAM Identity Center authorization failed");
  }
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1) {
    throw new Error("IAM Identity Center callback omitted the authorization code");
  }
  const code = text(codes[0]);
  if (!code) throw new Error("IAM Identity Center callback omitted the authorization code");
  return code;
}

export async function completeIdentityCenterAuthorization(
  authorization: IdentityCenterAuthorization,
  callbackUrl: string,
  input: { signal?: AbortSignal; fetch?: FetchFunction } = {},
): Promise<KiroIdentityCenterCredential> {
  if (Date.now() >= authorization.expiresAt) {
    throw new Error("IAM Identity Center authorization expired");
  }
  const code = identityCenterCallback(callbackUrl, authorization.state);
  const token = await postJson(
    oidcUrl(authorization.authRegion, "token"),
    {
      clientId: authorization.clientId,
      clientSecret: authorization.clientSecret,
      grantType: "authorization_code",
      redirectUri: IDENTITY_CENTER_REDIRECT_URI,
      code,
      codeVerifier: authorization.codeVerifier,
    },
    {
      fetch: input.fetch,
      signal: input.signal,
      action: "Kiro IAM Identity Center token exchange",
      secrets: [authorization.clientId, authorization.clientSecret, code, authorization.codeVerifier],
    },
  );
  const access = text(token.accessToken);
  const refresh = text(token.refreshToken);
  if (!access || !refresh) {
    throw new Error("Kiro IAM Identity Center token response omitted required tokens");
  }
  const machineId = randomUUID();
  const responseProfileArn = text(token.profileArn);
  const profileArn = responseProfileArn
    ? normalizeProfileArn(responseProfileArn)
    : await discoverAccountProfile({
        accessToken: access,
        machineId,
        identityProvider: "iam_identity_center",
        signal: input.signal,
        fetch: input.fetch,
      });
  return {
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + positiveSeconds(token.expiresIn, 3600) * 1000,
    authRegion: authorization.authRegion,
    startUrl: authorization.startUrl,
    clientId: authorization.clientId,
    clientSecret: authorization.clientSecret,
    machineId,
    identityProvider: "iam_identity_center",
    ...(profileArn ? { profileArn } : {}),
  };
}

export async function loginIdentityCenter(
  interaction: AuthInteraction,
): Promise<KiroIdentityCenterCredential> {
  const startUrl = await interaction.prompt({
    type: "text",
    message: "Enter your AWS Access Portal Start URL:",
    placeholder: "https://company.awsapps.com/start",
    signal: interaction.signal,
  });
  const region = await interaction.prompt({
    type: "text",
    message: "Enter your IAM Identity Center (SSO) region:",
    placeholder: DEFAULT_REGION,
    signal: interaction.signal,
  });
  interaction.notify({ type: "progress", message: "Starting IAM Identity Center sign-in…" });
  const authorization = await startIdentityCenterAuthorization({
    startUrl,
    region: region.trim() || DEFAULT_REGION,
    signal: interaction.signal,
  });
  interaction.notify({
    type: "auth_url",
    url: authorization.authorizationUrl,
    instructions:
      "Complete company SSO in the browser. When it redirects to 127.0.0.1, copy the full URL from the address bar and paste it here.",
  });
  const callbackUrl = await interaction.prompt({
    type: "manual_code",
    message: "Paste the full http://127.0.0.1/oauth/callback?... URL:",
    placeholder: `${IDENTITY_CENTER_REDIRECT_URI}?code=...&state=...`,
    signal: interaction.signal,
  });
  const credential = await completeIdentityCenterAuthorization(authorization, callbackUrl, {
    signal: interaction.signal,
  });
  interaction.notify({ type: "info", message: "Kiro IAM Identity Center sign-in completed." });
  return credential;
}

export async function loginKiroOAuth(interaction: AuthInteraction): Promise<KiroOAuthCredential> {
  const method = await interaction.prompt({
    type: "select",
    message: "Choose a Kiro account sign-in method:",
    options: [
      {
        id: "builder_id",
        label: "AWS Builder ID",
        description: "Personal Builder ID device authorization",
      },
      {
        id: "iam_identity_center",
        label: "AWS IAM Identity Center",
        description: "Company AWS Access Portal / enterprise SSO",
      },
    ],
    signal: interaction.signal,
  });
  if (method === "builder_id") return loginBuilderId(interaction);
  if (method === "iam_identity_center") return loginIdentityCenter(interaction);
  throw new Error("Unsupported Kiro account sign-in method");
}

export async function refreshKiroOAuth(
  credential: OAuthCredential,
  signal?: AbortSignal,
  fetch?: FetchFunction,
): Promise<KiroOAuthCredential> {
  if (!isKiroOAuthCredential(credential)) throw new Error("Invalid Kiro OAuth credential metadata");
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
      action: "Kiro account token refresh",
      secrets: [credential.clientId, credential.clientSecret, credential.refresh, credential.access],
    },
  );
  const access = text(response.accessToken);
  if (!access) throw new Error("Kiro account token refresh omitted the access token");
  const refresh = text(response.refreshToken) ?? credential.refresh;
  const responseProfileArn = text(response.profileArn);
  const profileArn = responseProfileArn
    ? normalizeProfileArn(responseProfileArn)
    : credential.profileArn
      ? normalizeProfileArn(credential.profileArn)
      : await discoverAccountProfile({
          accessToken: access,
          machineId: credential.machineId,
          identityProvider: credential.identityProvider,
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

/** Backward-compatible refresh helper for existing Builder ID consumers. */
export async function refreshBuilderId(
  credential: OAuthCredential,
  signal?: AbortSignal,
  fetch?: FetchFunction,
): Promise<KiroBuilderIdCredential> {
  const refreshed = await refreshKiroOAuth(credential, signal, fetch);
  if (refreshed.identityProvider !== "builder_id") {
    throw new Error("Expected a Kiro Builder ID credential");
  }
  return refreshed;
}
