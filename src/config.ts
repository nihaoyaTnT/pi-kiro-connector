import { createHash } from "node:crypto";
import { platform, release } from "node:os";

export const DEFAULT_REGION = "us-east-1";
export const KIRO_STREAMING_TARGET =
  "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

const REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const PROFILE_ARN_PATTERN =
  /^arn:aws:codewhisperer:([a-z]{2}(?:-[a-z0-9]+)+-[0-9]+):([0-9]{12}):profile\/([A-Za-z0-9+=,.@_-]+)$/;

export interface KiroCredential {
  apiKey: string;
  region: string;
}

export function normalizeRegion(value: string | undefined): string {
  const region = (value || DEFAULT_REGION).trim().toLowerCase();
  if (!REGION_PATTERN.test(region)) {
    throw new Error(`Invalid Kiro region: ${value}`);
  }
  return region;
}

/** Parse the Kiro CLI convenience form `ksk_...|region`. */
export function parseKiroCredential(raw: string, explicitRegion?: string): KiroCredential {
  const value = raw.trim();
  if (!value) throw new Error("Kiro API key is empty");

  const parts = value.split("|");
  if (parts.length > 2) throw new Error("Kiro API key contains multiple region separators");

  const apiKey = parts[0]?.trim();
  if (!apiKey) throw new Error("Kiro API key is empty");
  const embeddedRegion = parts[1]?.trim();
  if (parts.length === 2 && !embeddedRegion) {
    throw new Error("Kiro region after | is empty");
  }

  return { apiKey, region: normalizeRegion(explicitRegion || embeddedRegion) };
}

export function normalizeProfileArn(value: string): string {
  const profileArn = value.trim();
  if (!PROFILE_ARN_PATTERN.test(profileArn)) throw new Error("Invalid Kiro profile ARN");
  return profileArn;
}

export function profileRegion(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const profileArn = normalizeProfileArn(value);
  return profileArn.match(PROFILE_ARN_PATTERN)?.[1];
}

export function runtimeUrl(region: string): string {
  return `https://runtime.${normalizeRegion(region)}.kiro.dev/`;
}

export function builderIdRuntimeUrl(profileArn?: string): string {
  const region = profileRegion(profileArn) ?? DEFAULT_REGION;
  return `https://q.${region}.amazonaws.com/generateAssistantResponse`;
}

export function builderIdProfilesUrl(region: string): string {
  const normalized = normalizeRegion(region);
  const host = normalized === DEFAULT_REGION
    ? `codewhisperer.${DEFAULT_REGION}.amazonaws.com`
    : `q.${normalized}.amazonaws.com`;
  return `https://${host}/ListAvailableProfiles`;
}

export function modelsUrl(region: string): string {
  const normalized = normalizeRegion(region);
  return `https://codewhisperer.${normalized}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&maxResults=50`;
}

export function builderIdModelsUrl(profileArn?: string): string {
  const region = profileRegion(profileArn) ?? DEFAULT_REGION;
  const host = region === DEFAULT_REGION
    ? `codewhisperer.${DEFAULT_REGION}.amazonaws.com`
    : `q.${region}.amazonaws.com`;
  const url = new URL(`https://${host}/ListAvailableModels`);
  url.searchParams.set("origin", "AI_EDITOR");
  url.searchParams.set("maxResults", "50");
  if (profileArn) url.searchParams.set("profileArn", normalizeProfileArn(profileArn));
  return url.toString();
}

export function oidcUrl(region: string, path: "client/register" | "device_authorization" | "token"): string {
  return `https://oidc.${normalizeRegion(region)}.amazonaws.com/${path}`;
}

export function machineIdForApiKey(apiKey: string): string {
  return createHash("sha256").update(`KiroAPIKey/${apiKey}`).digest("hex");
}

function systemVersion(): string {
  const name = platform() === "win32" ? "win32" : platform() === "darwin" ? "darwin" : "linux";
  return `${name}#${release()}`.replace(/\s+/g, "_");
}

export function kiroUserAgentForMachineId(machineId: string, streaming: boolean): {
  userAgent: string;
  amzUserAgent: string;
} {
  const sdkVersion = streaming ? "1.0.34" : "1.0.0";
  const apiName = streaming ? "codewhispererstreaming" : "codewhispererruntime";
  const mode = streaming ? "m/E" : "m/N,E";
  const client = `KiroIDE-0.11.107-${machineId}`;
  return {
    userAgent: `aws-sdk-js/${sdkVersion} ua/2.1 os/${systemVersion()} lang/js md/nodejs#${process.versions.node} api/${apiName}#${sdkVersion} ${mode} ${client}`,
    amzUserAgent: `aws-sdk-js/${sdkVersion} ${client}`,
  };
}

export function kiroUserAgent(apiKey: string, streaming: boolean): {
  userAgent: string;
  amzUserAgent: string;
} {
  return kiroUserAgentForMachineId(machineIdForApiKey(apiKey), streaming);
}
