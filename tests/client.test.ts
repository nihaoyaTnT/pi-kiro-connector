import assert from "node:assert/strict";
import test from "node:test";
import { discoverModels, generateAssistantResponse, requestHeaders } from "../src/client.ts";
import { encodeEventStreamFrame } from "../src/eventstream.ts";
import type { KiroPayload } from "../src/translate.ts";

const payload: KiroPayload = {
  conversationState: {
    agentContinuationId: "continuation",
    agentTaskType: "vibe",
    chatTriggerType: "MANUAL",
    conversationId: "conversation",
    currentMessage: {
      userInputMessage: {
        content: "hello",
        modelId: "claude-sonnet-4.6",
        origin: "KIRO_CLI",
      },
    },
  },
};

test("builds Kiro CLI Runtime authentication headers", () => {
  const headers = requestHeaders("ksk_example|eu-central-1");
  assert.equal(headers.Authorization, "Bearer ksk_example");
  assert.equal(headers.tokentype, "API_KEY");
  assert.equal(headers["Content-Type"], "application/x-amz-json-1.0");
  assert.equal(
    headers["X-Amz-Target"],
    "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
  );
  assert.equal(headers["x-amzn-codewhisperer-optout"], "false");
  assert.match(headers["Amz-Sdk-Invocation-Id"] ?? "", /^[0-9a-f-]{36}$/);
});

test("calls the regional Runtime and decodes its stream", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  let responseStatus = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    const frame = encodeEventStreamFrame("assistantResponseEvent", { content: "OK" });
    return new Response(
      frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer,
      { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
    );
  };

  const events = [];
  for await (const event of generateAssistantResponse({
    rawKey: "ksk_example|eu-central-1",
    payload,
    fetch: fetcher,
    onResponse: (response) => {
      responseStatus = response.status;
    },
  })) {
    events.push(event);
  }

  assert.equal(requestUrl, "https://runtime.eu-central-1.kiro.dev/");
  assert.equal(requestInit?.method, "POST");
  assert.equal(responseStatus, 200);
  assert.equal(events[0]?.payload.content, "OK");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), payload);
});

test("discovers and deduplicates native Kiro model metadata", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://codewhisperer.eu-west-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&maxResults=50",
    );
    assert.equal(new Headers(init?.headers).get("tokentype"), "API_KEY");
    return Response.json({
      models: [
        {
          modelId: "claude-sonnet-4.6",
          modelName: "Claude Sonnet 4.6",
          supportedInputTypes: ["TEXT", "IMAGE"],
          tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
        },
        { modelId: "claude-sonnet-4.6" },
        { modelId: "auto", supportedInputTypes: ["TEXT"] },
        { noModelId: true },
      ],
    });
  };

  const models = await discoverModels({
    rawKey: "ksk_example",
    region: "eu-west-1",
    fetch: fetcher,
  });
  assert.deepEqual(models.map((model) => model.id), ["claude-sonnet-4.6", "auto"]);
  assert.equal(models[0]?.contextWindow, 1_000_000);
  assert.deepEqual(models[0]?.input, ["text", "image"]);
  assert.deepEqual(models[1]?.input, ["text"]);
});

test("does not echo credentials in upstream errors", async () => {
  const fetcher: typeof fetch = async () =>
    new Response("invalid ksk_super_secret token", { status: 401 });
  await assert.rejects(
    async () => {
      for await (const _event of generateAssistantResponse({
        rawKey: "ksk_super_secret",
        payload,
        fetch: fetcher,
      })) {
        // consume
      }
    },
    (error: unknown) => {
      assert.match(String(error), /HTTP 401/);
      assert.doesNotMatch(String(error), /ksk_super_secret/);
      assert.match(String(error), /\[REDACTED\]/);
      return true;
    },
  );
});
