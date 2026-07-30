import assert from "node:assert/strict";
import test from "node:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
  INTERNAL_AUTH_REGION,
  INTERNAL_AUTH_TYPE,
  INTERNAL_MACHINE_ID,
  INTERNAL_PROFILE_ARN,
} from "../src/auth.ts";
import { encodeEventStreamFrame } from "../src/eventstream.ts";
import { streamKiro } from "../src/stream.ts";

const model: Model<"kiro-runtime"> = {
  id: "claude-sonnet-4.6",
  name: "Claude Sonnet 4.6 (Kiro)",
  api: "kiro-runtime",
  provider: "kiro",
  baseUrl: "https://runtime.us-east-1.kiro.dev/",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 64_000,
};
const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
};

function responseWithFrames(...frames: Uint8Array[]): Response {
  const length = frames.reduce((sum, frame) => sum + frame.length, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const frame of frames) {
    body.set(frame, offset);
    offset += frame.length;
  }
  return new Response(body, { status: 200 });
}

test("maps Kiro reasoning and repeated text into Pi stream events", async () => {
  const fetcher: typeof fetch = async () =>
    responseWithFrames(
      encodeEventStreamFrame("reasoningContentEvent", { text: "think" }),
      encodeEventStreamFrame("assistantResponseEvent", { content: "ha" }),
      encodeEventStreamFrame("assistantResponseEvent", {
        content: "ha",
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
    );
  const events = [];
  const stream = streamKiro(model, context, { apiKey: "ksk_example", fetch: fetcher });
  for await (const event of stream) events.push(event);
  const result = await stream.result();

  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "think" },
    { type: "text", text: "haha" },
  ]);
  assert.equal(result.usage.input, 10);
  assert.equal(result.usage.output, 2);
  assert.ok(events.some((event) => event.type === "thinking_delta"));
  assert.equal(
    events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""),
    "haha",
  );
});

test("routes Pi OAuth stream options through the Builder ID data plane", async () => {
  const profileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example";
  let requestUrl = "";
  let requestHeaders = new Headers();
  let requestBody = "";
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    requestBody = String(init?.body);
    return responseWithFrames(encodeEventStreamFrame("assistantResponseEvent", { content: "signed in" }));
  };
  const stream = streamKiro(model, context, {
    apiKey: "builder_access_token",
    headers: {
      [INTERNAL_AUTH_TYPE]: "builder_id",
      [INTERNAL_AUTH_REGION]: "us-east-1",
      [INTERNAL_MACHINE_ID]: "12345678-1234-4234-8234-123456789abc",
      [INTERNAL_PROFILE_ARN]: profileArn,
    },
    fetch: fetcher,
  });
  const result = await stream.result();

  assert.equal(result.stopReason, "stop");
  assert.equal(requestUrl, "https://q.eu-central-1.amazonaws.com/generateAssistantResponse");
  assert.equal(requestHeaders.get("authorization"), "Bearer builder_access_token");
  assert.equal(requestHeaders.get(INTERNAL_AUTH_TYPE), null);
  const payload = JSON.parse(requestBody) as {
    profileArn?: string;
    conversationState: { currentMessage: { userInputMessage: { origin: string } } };
  };
  assert.equal(payload.profileArn, profileArn);
  assert.equal(payload.conversationState.currentMessage.userInputMessage.origin, "AI_EDITOR");
});

test("assembles fragmented Kiro tool input and emits a Pi tool call", async () => {
  const fetcher: typeof fetch = async () =>
    responseWithFrames(
      encodeEventStreamFrame("toolUseEvent", {
        name: "read",
        input: '{"path":',
      }),
      encodeEventStreamFrame("toolUseEvent", {
        toolUseId: "toolu_real",
        name: "read",
        input: '"README.md"}',
        stop: true,
      }),
    );
  const stream = streamKiro(model, context, { apiKey: "ksk_example", fetch: fetcher });
  const result = await stream.result();
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.content, [
    {
      type: "toolCall",
      id: "toolu_real",
      name: "read",
      arguments: { path: "README.md" },
    },
  ]);
});

test("reports missing credentials and cancellation as terminal errors", async () => {
  const missing = await streamKiro(model, context).result();
  assert.equal(missing.stopReason, "error");
  assert.match(missing.errorMessage ?? "", /login kiro/);

  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  const aborted = await streamKiro(model, context, {
    apiKey: "ksk_example",
    signal: controller.signal,
  }).result();
  assert.equal(aborted.stopReason, "aborted");
  assert.match(aborted.errorMessage ?? "", /cancelled by test/);
});
