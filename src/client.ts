import { randomUUID } from "node:crypto";
import type { FetchFunction, ProviderResponse } from "@earendil-works/pi-ai";
import {
  KIRO_STREAMING_TARGET,
  kiroUserAgent,
  modelsUrl,
  parseKiroCredential,
  runtimeUrl,
  type KiroCredential,
} from "./config.ts";
import { decodeEventStream, type KiroWireEvent } from "./eventstream.ts";
import { toModelConfig, type DiscoveredModel, type KiroModelConfig } from "./models.ts";
import type { KiroPayload } from "./translate.ts";

export interface KiroModelResponse {
  modelId?: unknown;
  modelName?: unknown;
  supportedInputTypes?: unknown;
  tokenLimits?: { maxInputTokens?: unknown; maxOutputTokens?: unknown };
}

function baseHeaders(credential: KiroCredential, streaming: boolean): Record<string, string> {
  const agent = kiroUserAgent(credential.apiKey, streaming);
  return {
    Authorization: `Bearer ${credential.apiKey}`,
    tokentype: "API_KEY",
    "User-Agent": agent.userAgent,
    "x-amz-user-agent": agent.amzUserAgent,
    "x-amzn-codewhisperer-optout": streaming ? "false" : "true",
  };
}

function safeErrorBody(text: string, secrets: readonly string[] = []): string {
  let normalized = text.replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret) normalized = normalized.split(secret).join("[REDACTED]");
  }
  return normalized.length > 500 ? `${normalized.slice(0, 500)}…` : normalized;
}

export function requestHeaders(rawKey: string, explicitRegion?: string): Record<string, string> {
  const credential = parseKiroCredential(rawKey, explicitRegion);
  return {
    ...baseHeaders(credential, true),
    Accept: "*/*",
    "Content-Type": "application/x-amz-json-1.0",
    "X-Amz-Target": KIRO_STREAMING_TARGET,
    "Amz-Sdk-Request": "attempt=1; max=1",
    "Amz-Sdk-Invocation-Id": randomUUID(),
  };
}

export async function* generateAssistantResponse(input: {
  rawKey: string;
  region?: string;
  payload: KiroPayload;
  signal?: AbortSignal;
  fetch?: FetchFunction;
  onResponse?: (response: ProviderResponse) => void | Promise<void>;
}): AsyncGenerator<KiroWireEvent> {
  const credential = parseKiroCredential(input.rawKey, input.region);
  const fetcher = input.fetch ?? globalThis.fetch;
  const response = await fetcher(runtimeUrl(credential.region), {
    method: "POST",
    headers: requestHeaders(credential.apiKey, credential.region),
    body: JSON.stringify(input.payload),
    signal: input.signal,
  });
  await input.onResponse?.({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
  });
  if (!response.ok) {
    const detail = safeErrorBody(await response.text(), [credential.apiKey, input.rawKey]);
    throw new Error(`Kiro Runtime request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!response.body) throw new Error("Kiro Runtime returned an empty response body");
  yield* decodeEventStream(response.body);
}

function discoveredModel(model: KiroModelResponse): DiscoveredModel | undefined {
  if (typeof model.modelId !== "string" || !model.modelId.trim()) return undefined;
  const inputs = Array.isArray(model.supportedInputTypes)
    ? model.supportedInputTypes.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    id: model.modelId,
    name: typeof model.modelName === "string" ? model.modelName : undefined,
    input_modalities: inputs,
    context_window:
      typeof model.tokenLimits?.maxInputTokens === "number"
        ? model.tokenLimits.maxInputTokens
        : undefined,
    max_tokens:
      typeof model.tokenLimits?.maxOutputTokens === "number"
        ? model.tokenLimits.maxOutputTokens
        : undefined,
  };
}

export async function discoverModels(input: {
  rawKey: string;
  region?: string;
  signal?: AbortSignal;
  fetch?: FetchFunction;
}): Promise<KiroModelConfig[]> {
  const credential = parseKiroCredential(input.rawKey, input.region);
  const response = await (input.fetch ?? globalThis.fetch)(modelsUrl(credential.region), {
    headers: {
      ...baseHeaders(credential, false),
      Accept: "application/json",
    },
    signal: input.signal,
  });
  if (!response.ok) {
    const detail = safeErrorBody(await response.text(), [credential.apiKey, input.rawKey]);
    throw new Error(`Kiro model discovery failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const body = (await response.json()) as { models?: unknown };
  if (!Array.isArray(body.models)) throw new Error("Kiro model discovery returned an invalid response");

  const seen = new Set<string>();
  return body.models
    .map((value) => discoveredModel(value as KiroModelResponse))
    .filter((value): value is DiscoveredModel => value !== undefined)
    .map(toModelConfig)
    .filter((value): value is KiroModelConfig => value !== undefined)
    .filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
}

export interface RuntimeProbe {
  ok: boolean;
  endpoint: string;
  status: number;
  modelCount: number;
  error?: string;
}

export async function probeKiro(input: {
  rawKey: string;
  region?: string;
  signal?: AbortSignal;
  fetch?: FetchFunction;
}): Promise<RuntimeProbe> {
  const credential = parseKiroCredential(input.rawKey, input.region);
  try {
    const models = await discoverModels(input);
    return {
      ok: true,
      endpoint: runtimeUrl(credential.region),
      status: 200,
      modelCount: models.length,
    };
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(message.match(/HTTP (\d+)/)?.[1] ?? 0);
    return {
      ok: false,
      endpoint: runtimeUrl(credential.region),
      status,
      modelCount: 0,
      error: message,
    };
  }
}
