import { createHash } from "node:crypto";
import { platform, release } from "node:os";

export const DEFAULT_REGION = "us-east-1";
export const KIRO_STREAMING_TARGET =
  "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

const REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

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

export function runtimeUrl(region: string): string {
  return `https://runtime.${normalizeRegion(region)}.kiro.dev/`;
}

export function modelsUrl(region: string): string {
  const normalized = normalizeRegion(region);
  return `https://codewhisperer.${normalized}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&maxResults=50`;
}

export function machineIdForApiKey(apiKey: string): string {
  return createHash("sha256").update(`KiroAPIKey/${apiKey}`).digest("hex");
}

function systemVersion(): string {
  const name = platform() === "win32" ? "win32" : platform() === "darwin" ? "darwin" : "linux";
  return `${name}#${release()}`.replace(/\s+/g, "_");
}

export function kiroUserAgent(apiKey: string, streaming: boolean): {
  userAgent: string;
  amzUserAgent: string;
} {
  const sdkVersion = streaming ? "1.0.34" : "1.0.0";
  const apiName = streaming ? "codewhispererstreaming" : "codewhispererruntime";
  const mode = streaming ? "m/E" : "m/N,E";
  const client = `KiroIDE-0.11.107-${machineIdForApiKey(apiKey)}`;
  return {
    userAgent: `aws-sdk-js/${sdkVersion} ua/2.1 os/${systemVersion()} lang/js md/nodejs#${process.versions.node} api/${apiName}#${sdkVersion} ${mode} ${client}`,
    amzUserAgent: `aws-sdk-js/${sdkVersion} ${client}`,
  };
}
