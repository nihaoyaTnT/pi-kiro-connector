import type { FetchFunction } from "@earendil-works/pi-ai";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export interface RequestPolicy {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  retryStatuses?: ReadonlySet<number>;
  /** Retry failures that occur before an HTTP response exists. Disable for non-idempotent operations. */
  retryNetworkErrors?: boolean;
  action?: string;
}

function abortError(signal: AbortSignal | undefined, fallback: unknown): unknown {
  return signal?.aborted ? signal.reason ?? new Error("Request aborted") : fallback;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function retryDelay(response: Response | undefined, retryIndex: number, maximum: number): number {
  const requested = response ? retryAfterMilliseconds(response) : undefined;
  if (requested !== undefined) {
    if (maximum > 0 && requested > maximum) {
      throw new Error(`Server requested a retry delay of ${requested}ms, exceeding the ${maximum}ms limit`);
    }
    return requested;
  }
  const exponential = 250 * 2 ** Math.min(retryIndex, 6);
  const jittered = Math.round(exponential * (0.75 + Math.random() * 0.5));
  return maximum > 0 ? Math.min(jittered, maximum) : jittered;
}

async function fetchAttempt(
  fetcher: FetchFunction,
  url: string,
  init: RequestInit,
  policy: RequestPolicy,
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(policy.signal?.reason ?? new Error("Request aborted"));
  policy.signal?.addEventListener("abort", onAbort, { once: true });
  if (policy.signal?.aborted) onAbort();

  const timer = timeoutMs > 0
    ? setTimeout(() => {
        controller.abort(new Error(`${policy.action ?? "Kiro request"} timed out after ${timeoutMs}ms`));
      }, timeoutMs)
    : undefined;

  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw abortError(policy.signal, controller.signal.aborted ? controller.signal.reason ?? error : error);
  } finally {
    if (timer) clearTimeout(timer);
    policy.signal?.removeEventListener("abort", onAbort);
  }
}

/** Fetch with bounded connection time and retries before a response body is consumed. */
export async function requestWithRetry(input: {
  fetch?: FetchFunction;
  url: string;
  init: (attempt: number, maxAttempts: number) => RequestInit;
  policy?: RequestPolicy;
}): Promise<Response> {
  const policy = input.policy ?? {};
  const retries = Math.max(0, Math.trunc(policy.maxRetries ?? DEFAULT_MAX_RETRIES));
  const maxAttempts = retries + 1;
  const statuses = policy.retryStatuses ?? RETRYABLE_STATUSES;
  const fetcher = input.fetch ?? globalThis.fetch;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (policy.signal?.aborted) throw policy.signal.reason ?? new Error("Request aborted");
    let response: Response | undefined;
    try {
      response = await fetchAttempt(fetcher, input.url, input.init(attempt, maxAttempts), policy);
      if (!statuses.has(response.status) || attempt === maxAttempts) return response;
    } catch (error) {
      if (policy.signal?.aborted) throw policy.signal.reason ?? error;
      lastError = error;
      if (policy.retryNetworkErrors === false || attempt === maxAttempts) throw error;
    }

    const delay = retryDelay(response, attempt - 1, policy.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
    if (response?.body) await response.body.cancel().catch(() => undefined);
    await wait(delay, policy.signal);
  }

  throw lastError ?? new Error(`${policy.action ?? "Kiro request"} failed`);
}

/** Read a response body without allowing an upstream peer to consume unbounded memory. */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
  action: string,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new Error(`${action} exceeded the ${maxBytes}-byte response limit`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        if (timeoutMs > 0) {
          timer = setTimeout(() => reject(new Error(`${action} timed out after ${timeoutMs}ms`)), timeoutMs);
        }
        if (signal) {
          onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), deadline]);
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${action} exceeded the ${maxBytes}-byte response limit`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readJsonObject(
  response: Response,
  action: string,
  maxBytes = MAX_JSON_BODY_BYTES,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const body = await readBoundedText(response, maxBytes, action, timeoutMs, signal);
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${action} returned an invalid JSON response`);
  }
}
