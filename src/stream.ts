import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { generateAssistantResponse } from "./client.ts";
import { translateContext } from "./translate.ts";

interface PendingTool {
  id: string;
  name: string;
  input: string;
  generatedId: boolean;
}

type OutputBlock = TextContent | ThinkingContent | ToolCall;

const EMPTY_USAGE = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function stringField(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return "";
}

function boolField(value: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => value[key] === true);
}

function numberField(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.max(0, Math.trunc(candidate));
    if (typeof candidate === "string" && candidate.trim() && Number.isFinite(Number(candidate))) {
      return Math.max(0, Math.trunc(Number(candidate)));
    }
  }
  return undefined;
}

function usageObjects(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) usageObjects(child, output);
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    output.push(object);
    for (const child of Object.values(object)) usageObjects(child, output);
  }
  return output;
}

function updateUsage(message: AssistantMessage, payload: Record<string, unknown>): void {
  for (const candidate of usageObjects(payload)) {
    const output = numberField(
      candidate,
      "outputTokens",
      "completionTokens",
      "totalOutputTokens",
      "output_tokens",
      "completion_tokens",
    );
    if (output !== undefined) message.usage.output = output;

    const input = numberField(
      candidate,
      "inputTokens",
      "promptTokens",
      "totalInputTokens",
      "input_tokens",
      "prompt_tokens",
    );
    if (input !== undefined) {
      message.usage.input = input;
      continue;
    }

    const uncached = numberField(candidate, "uncachedInputTokens", "uncached_input_tokens") ?? 0;
    const cacheRead = numberField(candidate, "cacheReadInputTokens", "cache_read_input_tokens") ?? 0;
    const cacheWrite =
      numberField(
        candidate,
        "cacheWriteInputTokens",
        "cache_write_input_tokens",
        "cacheCreationInputTokens",
        "cache_creation_input_tokens",
      ) ?? 0;
    if (uncached + cacheRead + cacheWrite > 0) {
      message.usage.input = uncached;
      message.usage.cacheRead = cacheRead;
      message.usage.cacheWrite = cacheWrite;
    }
  }
  message.usage.totalTokens =
    message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Native Pi stream adapter for Kiro's AWS EventStream protocol. */
export function streamKiro(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE(),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  void (async () => {
    let openText: { kind: "text" | "thinking"; index: number } | undefined;
    let pendingTool: PendingTool | undefined;
    let emitted = false;
    let sawTool = false;

    const closeText = (): void => {
      if (!openText) return;
      const block = output.content[openText.index];
      if (openText.kind === "text" && block?.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: openText.index,
          content: block.text,
          partial: output,
        });
      } else if (openText.kind === "thinking" && block?.type === "thinking") {
        stream.push({
          type: "thinking_end",
          contentIndex: openText.index,
          content: block.thinking,
          partial: output,
        });
      }
      openText = undefined;
    };

    const appendText = (kind: "text" | "thinking", delta: string): void => {
      if (!delta) return;
      if (openText?.kind !== kind) {
        closeText();
        const index = output.content.length;
        output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
        openText = { kind, index };
        stream.push(
          kind === "text"
            ? { type: "text_start", contentIndex: index, partial: output }
            : { type: "thinking_start", contentIndex: index, partial: output },
        );
      }
      const index = openText.index;
      const block = output.content[index];
      if (kind === "text" && block?.type === "text") {
        block.text += delta;
        stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
      } else if (kind === "thinking" && block?.type === "thinking") {
        block.thinking += delta;
        stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
      }
      emitted = true;
    };

    const finishTool = (): void => {
      if (!pendingTool) return;
      closeText();
      let arguments_: Record<string, unknown> = {};
      if (pendingTool.input.trim()) {
        const parsed = JSON.parse(pendingTool.input) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Kiro returned a non-object tool input");
        }
        arguments_ = parsed as Record<string, unknown>;
      }
      const name = translated.toolNameMap.get(pendingTool.name) ?? pendingTool.name;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: pendingTool.id,
        name,
        arguments: arguments_,
      };
      const index = output.content.length;
      output.content.push(toolCall);
      stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
      const delta = JSON.stringify(arguments_);
      if (delta) stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: output });
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
      pendingTool = undefined;
      emitted = true;
      sawTool = true;
    };

    const requestOptions = options ?? {};
    const translated = translateContext(model.id, context, {
      maxTokens: requestOptions.maxTokens,
      temperature: requestOptions.temperature,
      reasoning: requestOptions.reasoning,
    });

    try {
      const rawKey = requestOptions.apiKey?.trim();
      if (!rawKey) throw new Error("No Kiro API key. Run /login kiro or set KIRO_API_KEY.");
      if (requestOptions.signal?.aborted) {
        throw requestOptions.signal.reason ?? new Error("Request aborted");
      }

      const transformed = requestOptions.onPayload
        ? await requestOptions.onPayload(translated.payload, model)
        : undefined;
      const payload = (transformed ?? translated.payload) as typeof translated.payload;

      stream.push({ type: "start", partial: output });
      for await (const event of generateAssistantResponse({
        rawKey,
        region: requestOptions.env?.KIRO_REGION ?? process.env.KIRO_REGION,
        payload,
        signal: requestOptions.signal,
        fetch: requestOptions.fetch,
        onResponse: requestOptions.onResponse
          ? (response) => requestOptions.onResponse!(response, model)
          : undefined,
      })) {
        updateUsage(output, event.payload);
        if (event.type === "assistantResponseEvent") {
          finishTool();
          appendText("text", stringField(event.payload, "content"));
        } else if (event.type === "reasoningContentEvent") {
          finishTool();
          appendText("thinking", stringField(event.payload, "text"));
        } else if (event.type === "toolUseEvent") {
          closeText();
          const id = stringField(event.payload, "toolUseId", "toolUseID", "tool_use_id", "id");
          const name = stringField(event.payload, "name", "toolName", "tool_name");
          if (pendingTool && name && pendingTool.name !== name) finishTool();
          if (pendingTool && id && pendingTool.id !== id) {
            if (pendingTool.generatedId && (!name || pendingTool.name === name)) {
              pendingTool.id = id;
              pendingTool.generatedId = false;
            } else {
              finishTool();
            }
          }
          if (!pendingTool && name) {
            pendingTool = {
              id: id || `toolu_${crypto.randomUUID()}`,
              name,
              input: "",
              generatedId: !id,
            };
          }
          if (pendingTool) {
            const input = event.payload.input;
            if (typeof input === "string") pendingTool.input += input;
            else if (input && typeof input === "object" && !Array.isArray(input)) {
              pendingTool.input = JSON.stringify(input);
            }
            if (boolField(event.payload, "stop", "isStop", "done")) finishTool();
          }
        }
      }
      finishTool();
      closeText();
      if (requestOptions.signal?.aborted) {
        throw requestOptions.signal.reason ?? new Error("Request aborted");
      }
      if (!emitted) throw new Error("Kiro Runtime returned no assistant output");

      output.stopReason = sawTool ? "toolUse" : "stop";
      calculateCost(model, output.usage);
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end(output);
    } catch (error) {
      try {
        finishTool();
        closeText();
      } catch {
        // Keep the original failure when cleanup cannot parse an incomplete tool fragment.
      }
      output.stopReason = requestOptions.signal?.aborted ? "aborted" : "error";
      output.errorMessage = errorText(error);
      calculateCost(model, output.usage);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end(output);
    }
  })();

  return stream;
}
