import type { OAuthCredential, ProviderEnv, ProviderHeaders } from "@earendil-works/pi-ai";
import {
  machineIdForApiKey,
  normalizeProfileArn,
  normalizeRegion,
  parseKiroCredential,
} from "./config.ts";

export const INTERNAL_AUTH_TYPE = "x-pi-kiro-auth-type";
export const INTERNAL_AUTH_REGION = "x-pi-kiro-auth-region";
export const INTERNAL_MACHINE_ID = "x-pi-kiro-machine-id";
export const INTERNAL_PROFILE_ARN = "x-pi-kiro-profile-arn";

export type KiroRequestAuth =
  | {
      type: "api_key";
      token: string;
      region: string;
      machineId: string;
    }
  | {
      type: "account";
      token: string;
      authRegion: string;
      machineId: string;
      profileArn?: string;
    };

export type KiroIdentityProvider = "builder_id" | "iam_identity_center";

interface KiroOAuthCredentialBase extends OAuthCredential {
  authRegion: string;
  clientId: string;
  clientSecret: string;
  machineId: string;
  profileArn?: string;
}

export interface KiroBuilderIdCredential extends KiroOAuthCredentialBase {
  identityProvider: "builder_id";
}

export interface KiroIdentityCenterCredential extends KiroOAuthCredentialBase {
  identityProvider: "iam_identity_center";
  startUrl: string;
}

export type KiroOAuthCredential = KiroBuilderIdCredential | KiroIdentityCenterCredential;

function headerValue(headers: ProviderHeaders | undefined, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" && entry[1].trim() ? entry[1].trim() : undefined;
}

function normalizeMachineId(value: string | undefined): string {
  const machineId = value?.trim();
  if (!machineId || !/^[A-Za-z0-9-]{8,128}$/.test(machineId)) {
    throw new Error("Invalid Kiro machine identifier");
  }
  return machineId;
}

export function apiKeyRequestAuth(rawKey: string, region?: string): KiroRequestAuth {
  const parsed = parseKiroCredential(rawKey, region);
  return {
    type: "api_key",
    token: parsed.apiKey,
    region: parsed.region,
    machineId: machineIdForApiKey(parsed.apiKey),
  };
}

export function accountRequestAuth(credential: KiroOAuthCredential): KiroRequestAuth {
  if (!credential.access?.trim()) throw new Error("Kiro account access token is empty");
  return {
    type: "account",
    token: credential.access.trim(),
    authRegion: normalizeRegion(credential.authRegion),
    machineId: normalizeMachineId(credential.machineId),
    ...(credential.profileArn
      ? { profileArn: normalizeProfileArn(credential.profileArn) }
      : {}),
  };
}

/** Backward-compatible name retained for consumers of the Builder ID helper. */
export const builderIdRequestAuth = accountRequestAuth;

/** Decode provider-owned metadata. These headers are consumed locally and never sent upstream. */
export function requestAuthFromOptions(
  token: string,
  env?: ProviderEnv,
  headers?: ProviderHeaders,
): KiroRequestAuth {
  const authType = headerValue(headers, INTERNAL_AUTH_TYPE);
  if (authType === "account" || authType === "builder_id") {
    const profileArn = headerValue(headers, INTERNAL_PROFILE_ARN);
    return {
      type: "account",
      token: token.trim(),
      authRegion: normalizeRegion(headerValue(headers, INTERNAL_AUTH_REGION)),
      machineId: normalizeMachineId(headerValue(headers, INTERNAL_MACHINE_ID)),
      ...(profileArn ? { profileArn: normalizeProfileArn(profileArn) } : {}),
    };
  }
  return apiKeyRequestAuth(token, env?.KIRO_REGION);
}

export function accountAuthHeaders(
  credential: KiroOAuthCredential,
): Record<string, string> {
  const auth = accountRequestAuth(credential);
  if (auth.type !== "account") throw new Error("Expected Kiro account authentication");
  return {
    [INTERNAL_AUTH_TYPE]: auth.type,
    [INTERNAL_AUTH_REGION]: auth.authRegion,
    [INTERNAL_MACHINE_ID]: auth.machineId,
    ...(auth.profileArn ? { [INTERNAL_PROFILE_ARN]: auth.profileArn } : {}),
  };
}

/** Backward-compatible name retained for consumers of the Builder ID helper. */
export const builderIdAuthHeaders = accountAuthHeaders;

export function isKiroOAuthCredential(value: OAuthCredential): value is KiroOAuthCredential {
  return (
    (value.identityProvider === "builder_id" || value.identityProvider === "iam_identity_center") &&
    typeof value.authRegion === "string" &&
    typeof value.clientId === "string" &&
    typeof value.clientSecret === "string" &&
    typeof value.machineId === "string" &&
    (value.identityProvider !== "iam_identity_center" || typeof value.startUrl === "string")
  );
}

export function isBuilderIdCredential(value: OAuthCredential): value is KiroBuilderIdCredential {
  return value.identityProvider === "builder_id" && isKiroOAuthCredential(value);
}

export function isIdentityCenterCredential(
  value: OAuthCredential,
): value is KiroIdentityCenterCredential {
  return value.identityProvider === "iam_identity_center" && isKiroOAuthCredential(value);
}
