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
import {
  MAX_ERROR_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  readBoundedText,
  readJsonObject,
  requestWithRetry,
  type RequestPolicy,
} from "./http.ts";
import { toModelConfig, type DiscoveredModel, type KiroModelConfig } from "./models.ts";
import type { KiroPayload } from "./translate.ts";

export interface KiroModelResponse {
  modelId?: unknown;
  modelName?: unknown;
  supportedInputTypes?: unknown;
  tokenLimits?: { maxInputTokens?: unknown; maxOutputTokens?: unknown };
}

const MAX_MODEL_PAGES = 20;

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

export function headersForAuth(
  auth: KiroRequestAuth,
  attempt = 1,
  maxAttempts = 1,
  invocationId = randomUUID(),
): Record<string, string> {
  return {
    ...baseHeaders(auth, true),
    Accept: "*/*",
    "Content-Type": auth.type === "api_key" ? "application/x-amz-json-1.0" : "application/json",
    ...(auth.type === "api_key" ? { "X-Amz-Target": KIRO_STREAMING_TARGET } : {}),
    ...(auth.type === "account" ? { "x-amzn-kiro-agent-mode": "vibe" } : {}),
    "Amz-Sdk-Request": `attempt=${attempt}; max=${maxAttempts}`,
    "Amz-Sdk-Invocation-Id": invocationId,
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
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  onResponse?: (response: ProviderResponse) => void | Promise<void>;
}): AsyncGenerator<KiroWireEvent> {
  const invocationId = randomUUID();
  const policy: RequestPolicy = {
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
    maxRetryDelayMs: input.maxRetryDelayMs,
    retryNetworkErrors: false,
    action: "Kiro Runtime request",
  };
  const response = await requestWithRetry({
    fetch: input.fetch,
    url: endpoint(input.auth),
    policy,
    init: (attempt, maxAttempts) => ({
      method: "POST",
      headers: headersForAuth(input.auth, attempt, maxAttempts, invocationId),
      body: JSON.stringify(payloadForAuth(input.payload, input.auth)),
    }),
  });
  await input.onResponse?.({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
  });
  if (!response.ok) {
    const detail = safeErrorBody(
      await readBoundedText(
        response,
        MAX_ERROR_BODY_BYTES,
        "Kiro Runtime error response",
        input.timeoutMs,
        input.signal,
      ),
      [input.auth.token],
    );
    throw new Error(`Kiro Runtime request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!response.body) throw new Error("Kiro Runtime returned an empty response body");
  yield* decodeEventStream(response.body, {
    signal: input.signal,
    idleTimeoutMs: input.timeoutMs,
  });
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
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}): Promise<KiroModelConfig[]> {
  const discovered: DiscoveredModel[] = [];
  const pageTokens = new Set<string>();
  let nextToken: string | undefined;

  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const url = new URL(catalogUrl(input.auth));
    if (nextToken) url.searchParams.set("nextToken", nextToken);
    const response = await requestWithRetry({
      fetch: input.fetch,
      url: url.toString(),
      policy: {
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        maxRetries: input.maxRetries,
        maxRetryDelayMs: input.maxRetryDelayMs,
        action: "Kiro model discovery",
      },
      init: () => ({
        headers: {
          ...baseHeaders(input.auth, false),
          Accept: "application/json",
        },
      }),
    });
    if (!response.ok) {
      const detail = safeErrorBody(
        await readBoundedText(
          response,
          MAX_ERROR_BODY_BYTES,
          "Kiro model discovery error response",
          input.timeoutMs,
          input.signal,
        ),
        [input.auth.token],
      );
      throw new Error(`Kiro model discovery failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
    }
    const body = await readJsonObject(
      response,
      "Kiro model discovery",
      MAX_JSON_BODY_BYTES,
      input.timeoutMs,
      input.signal,
    );
    if (!Array.isArray(body.models)) throw new Error("Kiro model discovery returned an invalid response");
    discovered.push(
      ...body.models
        .map((value) => discoveredModel(value as KiroModelResponse))
        .filter((value): value is DiscoveredModel => value !== undefined),
    );

    nextToken = typeof body.nextToken === "string" && body.nextToken.trim()
      ? body.nextToken.trim()
      : undefined;
    if (!nextToken) break;
    if (pageTokens.has(nextToken)) throw new Error("Kiro model discovery returned a repeated page token");
    pageTokens.add(nextToken);
  }
  if (nextToken) throw new Error(`Kiro model discovery exceeded ${MAX_MODEL_PAGES} pages`);

  const seen = new Set<string>();
  return discovered
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
