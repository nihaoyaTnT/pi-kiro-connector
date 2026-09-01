import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { translateContext } from "../src/translate.ts";

const now = 1;

test("translates system, image, inference, and tool definitions", () => {
  const context: Context = {
    systemPrompt: "Follow project instructions.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
        timestamp: now,
      },
    ],
    tools: [
      {
        name: "mcp.tool/read",
        description: "Read a resource",
        parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
      },
    ],
  };

  const translated = translateContext("claude-sonnet-4.6", context, {
    reasoning: "high",
    maxTokens: 4096,
    temperature: 0.2,
  });
  const state = translated.payload.conversationState;
  const current = state.currentMessage.userInputMessage;
  assert.equal(current.content, "Inspect this");
  assert.deepEqual(current.images, [{ format: "png", source: { bytes: "aGVsbG8=" } }]);
  assert.match(state.history?.[0]?.userInputMessage?.content ?? "", /thinking_mode/);
  assert.match(state.history?.[0]?.userInputMessage?.content ?? "", /Follow project instructions/);
  assert.deepEqual(translated.payload.inferenceConfig, { maxTokens: 4096, temperature: 0.2 });

  const specification = current.userInputMessageContext?.tools?.[0]?.toolSpecification;
  assert.equal(specification?.name, "mcp_tool_read");
  assert.equal(translated.toolNameMap.get("mcp_tool_read"), "mcp.tool/read");
  assert.doesNotMatch(JSON.stringify(specification?.inputSchema.json), /additionalProperties/);
});

test("uses the hashed Pi session id to isolate upstream conversations", () => {
  const context: Context = {
    systemPrompt: "same",
    messages: [{ role: "user", content: "same", timestamp: now }],
  };
  const first = translateContext("claude-sonnet-4.6", context, { sessionId: "session-a" })
    .payload.conversationState.conversationId;
  const repeated = translateContext("claude-sonnet-4.6", context, { sessionId: "session-a" })
    .payload.conversationState.conversationId;
  const second = translateContext("claude-sonnet-4.6", context, { sessionId: "session-b" })
    .payload.conversationState.conversationId;

  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /session-a/);
});

test("keeps only the active assistant tool turn structured", () => {
  const context: Context = {
    messages: [
      { role: "user", content: "Run it", timestamp: now },
      {
        role: "assistant",
        api: "kiro-runtime",
        provider: "kiro",
        model: "claude-sonnet-4.6",
        content: [
          {
            type: "toolCall",
            id: "toolu_1",
            name: "mcp.tool/read",
            arguments: { path: "README.md" },
          },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: now,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_1",
        toolName: "mcp.tool/read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: now,
      },
    ],
    tools: [
      {
        name: "mcp.tool/read",
        description: "Read",
        parameters: Type.Object({ path: Type.String() }),
      },
    ],
  };

  const translated = translateContext("claude-sonnet-4.6", context);
  const history = translated.payload.conversationState.history ?? [];
  const active = history.at(-1)?.assistantResponseMessage;
  assert.equal(active?.toolUses?.[0]?.toolUseId, "toolu_1");
  assert.equal(active?.toolUses?.[0]?.name, "mcp_tool_read");
  assert.equal(
    translated.payload.conversationState.currentMessage.userInputMessage
      .userInputMessageContext?.toolResults?.[0]?.toolUseId,
    "toolu_1",
  );
});

test("groups consecutive historical tool results into one Kiro user turn", () => {
  const context: Context = {
    messages: [
      { role: "user", content: "Start", timestamp: now },
      {
        role: "toolResult",
        toolCallId: "toolu_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
        timestamp: now,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_2",
        toolName: "grep",
        content: [{ type: "text", text: "second" }],
        isError: false,
        timestamp: now,
      },
      { role: "user", content: "Continue", timestamp: now },
    ],
  };

  const history = translateContext("claude-sonnet-4.6", context).payload.conversationState.history ?? [];
  const toolTurns = history.filter((entry) =>
    entry.userInputMessage?.content.startsWith("Tool results:"),
  );
  assert.equal(toolTurns.length, 1);
  assert.match(toolTurns[0]?.userInputMessage?.content ?? "", /\[read\] first/);
  assert.match(toolTurns[0]?.userInputMessage?.content ?? "", /\[grep\] second/);
});

test("flattens orphaned tool results instead of sending invalid structure", () => {
  const context: Context = {
    messages: [
      {
        role: "toolResult",
        toolCallId: "missing",
        toolName: "read",
        content: [{ type: "text", text: "orphan output" }],
        isError: true,
        timestamp: now,
      },
    ],
  };
  const current = translateContext("claude-sonnet-4.6", context).payload.conversationState
    .currentMessage.userInputMessage;
  assert.equal(current.userInputMessageContext?.toolResults, undefined);
  assert.match(current.content, /orphan output/);
});
