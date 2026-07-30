import { randomUUID } from "node:crypto";
import type { FetchFunction, ProviderResponse } from "@earendil-works/pi-ai";
import { apiKeyRequestAuth, type KiroRequestAuth } from "./auth.ts";
import {
  builderIdModelsUrl,
  builderIdRuntimeUrl,
  KIRO_STREAMING_TARGET,
  kiroUserAgentForMachineId,
  modelsUrl,
  runtimeUrl,
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

function endpoint(auth: KiroRequestAuth): string {
  return auth.type === "api_key" ? runtimeUrl(auth.region) : builderIdRuntimeUrl(auth.profileArn);
}

function catalogUrl(auth: KiroRequestAuth): string {
  return auth.type === "api_key" ? modelsUrl(auth.region) : builderIdModelsUrl(auth.profileArn);
}

function baseHeaders(auth: KiroRequestAuth, streaming: boolean): Record<string, string> {
  const agent = kiroUserAgentForMachineId(auth.machineId, streaming);
  return {
    Authorization: `Bearer ${auth.token}`,
    ...(auth.type === "api_key" ? { tokentype: "API_KEY" } : {}),
    "User-Agent": agent.userAgent,
    "x-amz-user-agent": agent.amzUserAgent,
    "x-amzn-codewhisperer-optout": auth.type === "api_key" && streaming ? "false" : "true",
  };
}

function safeErrorBody(text: string, secrets: readonly string[] = []): string {
  let normalized = text.replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret) normalized = normalized.split(secret).join("[REDACTED]");
  }
  return normalized.length > 500 ? `${normalized.slice(0, 500)}…` : normalized;
}

export function headersForAuth(auth: KiroRequestAuth): Record<string, string> {
  return {
    ...baseHeaders(auth, true),
    Accept: "*/*",
    "Content-Type": auth.type === "api_key" ? "application/x-amz-json-1.0" : "application/json",
    ...(auth.type === "api_key" ? { "X-Amz-Target": KIRO_STREAMING_TARGET } : {}),
    ...(auth.type === "account" ? { "x-amzn-kiro-agent-mode": "vibe" } : {}),
    "Amz-Sdk-Request": "attempt=1; max=1",
    "Amz-Sdk-Invocation-Id": randomUUID(),
  };
}

/** Backward-compatible helper for API-key request header tests and consumers. */
export function requestHeaders(rawKey: string, explicitRegion?: string): Record<string, string> {
  return headersForAuth(apiKeyRequestAuth(rawKey, explicitRegion));
}

function payloadForAuth(payload: KiroPayload, auth: KiroRequestAuth): KiroPayload {
  const origin = auth.type === "api_key" ? "KIRO_CLI" : "AI_EDITOR";
  const { profileArn: _untrustedProfileArn, ...safePayload } = payload;
  return {
    ...safePayload,
    conversationState: {
      ...payload.conversationState,
      currentMessage: {
        userInputMessage: {
          ...payload.conversationState.currentMessage.userInputMessage,
          origin,
        },
      },
      ...(payload.conversationState.history
        ? {
            history: payload.conversationState.history.map((entry) =>
              entry.userInputMessage
                ? { userInputMessage: { ...entry.userInputMessage, origin } }
                : entry,
            ),
          }
        : {}),
    },
    ...(auth.type === "account" && auth.profileArn ? { profileArn: auth.profileArn } : {}),
  };
}

export async function* generateAssistantResponse(input: {
  auth: KiroRequestAuth;
  payload: KiroPayload;
  signal?: AbortSignal;
  fetch?: FetchFunction;
  onResponse?: (response: ProviderResponse) => void | Promise<void>;
}): AsyncGenerator<KiroWireEvent> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const response = await fetcher(endpoint(input.auth), {
    method: "POST",
    headers: headersForAuth(input.auth),
    body: JSON.stringify(payloadForAuth(input.payload, input.auth)),
    signal: input.signal,
  });
  await input.onResponse?.({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
  });
  if (!response.ok) {
    const detail = safeErrorBody(await response.text(), [input.auth.token]);
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
  auth: KiroRequestAuth;
  signal?: AbortSignal;
  fetch?: FetchFunction;
}): Promise<KiroModelConfig[]> {
  const response = await (input.fetch ?? globalThis.fetch)(catalogUrl(input.auth), {
    headers: {
      ...baseHeaders(input.auth, false),
      Accept: "application/json",
    },
    signal: input.signal,
  });
  if (!response.ok) {
    const detail = safeErrorBody(await response.text(), [input.auth.token]);
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
  auth: KiroRequestAuth;
  signal?: AbortSignal;
  fetch?: FetchFunction;
}): Promise<RuntimeProbe> {
  try {
    const models = await discoverModels(input);
    return {
      ok: true,
      endpoint: endpoint(input.auth),
      status: 200,
      modelCount: models.length,
    };
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(message.match(/HTTP (\d+)/)?.[1] ?? 0);
    return {
      ok: false,
      endpoint: endpoint(input.auth),
      status,
      modelCount: 0,
      error: message,
    };
  }
}
