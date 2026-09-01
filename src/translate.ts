import { createHash, randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  TextContent,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}

export interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface KiroToolResult {
  toolUseId: string;
  content: Array<{ text: string }>;
  status: "success" | "error";
}

export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "KIRO_CLI" | "AI_EDITOR";
  images?: KiroImage[];
  userInputMessageContext?: {
    tools?: Array<{
      toolSpecification: {
        name: string;
        description: string;
        inputSchema: { json: unknown };
      };
    }>;
    toolResults?: KiroToolResult[];
  };
}

export interface KiroPayload {
  conversationState: {
    agentContinuationId: string;
    agentTaskType: "vibe";
    chatTriggerType: "MANUAL";
    conversationId: string;
    currentMessage: { userInputMessage: KiroUserInputMessage };
    history?: Array<{
      userInputMessage?: KiroUserInputMessage;
      assistantResponseMessage?: { content: string; toolUses?: KiroToolUse[] };
    }>;
  };
  profileArn?: string;
  inferenceConfig?: { maxTokens?: number; temperature?: number };
}

export interface TranslatedRequest {
  payload: KiroPayload;
  toolNameMap: Map<string, string>;
}

const THINKING_PROMPT =
  "<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>200000</max_thinking_length>";
const EMPTY_CONTENT = ".";
const MAX_TOOL_DESCRIPTION = 10_237;

function textAndImages(content: string | Array<TextContent | ImageContent>): {
  text: string;
  images: KiroImage[];
} {
  if (typeof content === "string") return { text: content, images: [] };
  const text: string[] = [];
  const images: KiroImage[] = [];
  for (const block of content) {
    if (block.type === "text") text.push(block.text);
    else {
      const format = block.mimeType.toLowerCase().replace(/^image\//, "");
      if (format && block.data) images.push({ format, source: { bytes: block.data } });
    }
  }
  return { text: text.join("\n"), images };
}

function toolResultText(message: ToolResultMessage): string {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const imageCount = message.content.filter((block) => block.type === "image").length;
  const suffix = imageCount > 0 ? `\n[Tool returned ${imageCount} image${imageCount === 1 ? "" : "s"}.]` : "";
  return (text || "(no output)") + suffix;
}

function assistantMessage(message: AssistantMessage): {
  content: string;
  toolUses: KiroToolUse[];
} {
  const content: string[] = [];
  const toolUses: KiroToolUse[] = [];
  for (const block of message.content) {
    if (block.type === "text") content.push(block.text);
    else if (block.type === "toolCall") {
      toolUses.push({
        toolUseId: block.id,
        name: block.name,
        input: block.arguments,
      });
    }
  }
  return { content: content.join(""), toolUses };
}

function cleanSchema(value: unknown, root = false): unknown {
  if (Array.isArray(value)) return value.map((child) => cleanSchema(child));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if (key === "required" && (!Array.isArray(child) || child.length === 0)) continue;
    output[key] = cleanSchema(child);
  }
  if (root && !("type" in output)) output.type = "object";
  return output;
}

function sanitizedToolName(name: string, used: Set<string>): string {
  let candidate = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 64);
  if (!candidate) candidate = "tool";
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 8);
  candidate = `${candidate.slice(0, 55)}_${suffix}`;
  let unique = candidate;
  let index = 2;
  while (used.has(unique)) unique = `${candidate.slice(0, 61)}_${index++}`;
  used.add(unique);
  return unique;
}

function convertTools(tools: Tool[] | undefined): {
  tools: NonNullable<KiroUserInputMessage["userInputMessageContext"]>["tools"];
  map: Map<string, string>;
} {
  const used = new Set<string>();
  const map = new Map<string, string>();
  const converted = (tools ?? []).map((tool) => {
    const name = sanitizedToolName(tool.name, used);
    map.set(name, tool.name);
    return {
      toolSpecification: {
        name,
        description: (tool.description || `Use the ${tool.name} tool.`).slice(0, MAX_TOOL_DESCRIPTION),
        inputSchema: { json: cleanSchema(tool.parameters, true) },
      },
    };
  });
  return { tools: converted, map };
}

function conversationId(modelId: string, context: Context, sessionId?: string): string {
  const firstUser = context.messages.find((message) => message.role === "user");
  const anchor = firstUser?.role === "user" ? textAndImages(firstUser.content).text : "";
  const identity = sessionId?.trim() || `${context.systemPrompt ?? ""}\0${anchor}`;
  const bytes = createHash("sha256")
    .update(`${modelId}\0${identity}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function userMessage(
  modelId: string,
  text: string,
  images: KiroImage[] = [],
): KiroUserInputMessage {
  return {
    content: text.trim() || EMPTY_CONTENT,
    modelId,
    origin: "KIRO_CLI",
    ...(images.length > 0 ? { images } : {}),
  };
}

export function translateContext(
  modelId: string,
  context: Context,
  options: { maxTokens?: number; temperature?: number; reasoning?: string; sessionId?: string } = {},
): TranslatedRequest {
  const history: KiroPayload["conversationState"]["history"] = [];
  const messages = context.messages;
  let currentText = "";
  let currentImages: KiroImage[] = [];
  let currentToolResults: KiroToolResult[] = [];
  let historyEnd = messages.length;

  // The final user message, or a trailing group of tool results, is Kiro's current message.
  if (messages.at(-1)?.role === "user") {
    const last = messages.at(-1)!;
    if (last.role === "user") {
      ({ text: currentText, images: currentImages } = textAndImages(last.content));
      historyEnd--;
    }
  } else if (messages.at(-1)?.role === "toolResult") {
    let start = messages.length - 1;
    while (start > 0 && messages[start - 1]?.role === "toolResult") start--;
    const trailing = messages.slice(start) as ToolResultMessage[];
    currentToolResults = trailing.map((message) => ({
      toolUseId: message.toolCallId,
      content: [{ text: toolResultText(message) }],
      status: message.isError ? "error" : "success",
    }));
    for (const message of trailing) {
      currentImages.push(
        ...message.content
          .filter((block): block is ImageContent => block.type === "image")
          .map((block) => ({
            format: block.mimeType.toLowerCase().replace(/^image\//, ""),
            source: { bytes: block.data },
          })),
      );
    }
    currentText = "Tool results:";
    historyEnd = start;
  }

  let systemPrompt = context.systemPrompt?.trim() ?? "";
  if (options.reasoning) systemPrompt = `${THINKING_PROMPT}${systemPrompt ? `\n\n${systemPrompt}` : ""}`;
  if (systemPrompt) {
    history.push({ userInputMessage: userMessage(modelId, systemPrompt) });
    history.push({ assistantResponseMessage: { content: "I will follow these instructions." } });
  }

  for (let index = 0; index < historyEnd; index++) {
    const message = messages[index]!;
    if (message.role === "user") {
      const converted = textAndImages(message.content);
      history.push({ userInputMessage: userMessage(modelId, converted.text, converted.images) });
    } else if (message.role === "assistant") {
      const converted = assistantMessage(message);
      history.push({
        assistantResponseMessage: {
          content: converted.content,
          ...(converted.toolUses.length > 0 ? { toolUses: converted.toolUses } : {}),
        },
      });
    } else {
      const results: ToolResultMessage[] = [message];
      while (index + 1 < historyEnd && messages[index + 1]?.role === "toolResult") {
        results.push(messages[++index] as ToolResultMessage);
      }
      const images = results.flatMap((result) =>
        result.content
          .filter((block): block is ImageContent => block.type === "image")
          .map((block) => ({
            format: block.mimeType.toLowerCase().replace(/^image\//, ""),
            source: { bytes: block.data },
          })),
      );
      history.push({
        userInputMessage: userMessage(
          modelId,
          `Tool results:\n\n${results
            .map((result) => `[${result.toolName}] ${toolResultText(result)}`)
            .join("\n\n")}`,
          images,
        ),
      });
    }
  }

  // Only the immediately preceding assistant tool turn may remain structured.
  if (currentToolResults.length > 0) {
    const last = history.at(-1)?.assistantResponseMessage;
    const resultIds = new Set(currentToolResults.map((result) => result.toolUseId));
    const matches = last?.toolUses?.length && last.toolUses.every((tool) => resultIds.has(tool.toolUseId));
    if (!matches) {
      currentText += `\n\n${currentToolResults.map((result) => result.content[0]?.text ?? "").join("\n\n")}`;
      currentToolResults = [];
    }
  }

  // Structured tool calls are valid only for the active assistant/tool-result turn.
  const activeAssistantIndex = currentToolResults.length > 0 ? history.length - 1 : -1;
  for (let index = 0; index < history.length; index++) {
    const assistant = history[index]?.assistantResponseMessage;
    if (assistant?.toolUses && index !== activeAssistantIndex) delete assistant.toolUses;
  }

  const convertedTools = convertTools(context.tools);
  const upstreamToolNames = new Map(
    [...convertedTools.map.entries()].map(([upstream, original]) => [original, upstream]),
  );
  for (const entry of history) {
    for (const toolUse of entry.assistantResponseMessage?.toolUses ?? []) {
      toolUse.name = upstreamToolNames.get(toolUse.name) ?? toolUse.name;
    }
  }

  const current = userMessage(modelId, currentText, currentImages);
  if ((convertedTools.tools?.length ?? 0) > 0 || currentToolResults.length > 0) {
    current.userInputMessageContext = {
      ...(convertedTools.tools?.length ? { tools: convertedTools.tools } : {}),
      ...(currentToolResults.length ? { toolResults: currentToolResults } : {}),
    };
  }

  const payload: KiroPayload = {
    conversationState: {
      agentContinuationId: randomUUID(),
      agentTaskType: "vibe",
      chatTriggerType: "MANUAL",
      conversationId: conversationId(modelId, context, options.sessionId),
      currentMessage: { userInputMessage: current },
      ...(history.length > 0 ? { history } : {}),
    },
  };
  if (options.maxTokens || options.temperature !== undefined) {
    payload.inferenceConfig = {
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };
  }

  return { payload, toolNameMap: convertedTools.map };
}
