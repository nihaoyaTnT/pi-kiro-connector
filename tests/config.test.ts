import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REGION,
  KIRO_STREAMING_TARGET,
  kiroUserAgent,
  machineIdForApiKey,
  modelsUrl,
  normalizeRegion,
  parseKiroCredential,
  runtimeUrl,
} from "../src/config.ts";

test("parses API keys with embedded or explicit regions", () => {
  assert.deepEqual(parseKiroCredential(" ksk_example | eu-central-1 "), {
    apiKey: "ksk_example",
    region: "eu-central-1",
  });
  assert.deepEqual(parseKiroCredential("ksk_example|eu-west-1", "ap-southeast-1"), {
    apiKey: "ksk_example",
    region: "ap-southeast-1",
  });
  assert.deepEqual(parseKiroCredential("ksk_example"), {
    apiKey: "ksk_example",
    region: DEFAULT_REGION,
  });
});

test("rejects empty keys and host-unsafe regions", () => {
  assert.throws(() => parseKiroCredential(""), /empty/i);
  assert.throws(() => parseKiroCredential("ksk_example|"), /region after/i);
  assert.throws(() => parseKiroCredential("ksk_example|a|b"), /multiple/i);
  assert.throws(() => normalizeRegion("us-east-1.example.com"), /invalid/i);
  assert.throws(() => normalizeRegion("../secret"), /invalid/i);
});

test("builds only approved regional Kiro endpoints", () => {
  assert.equal(runtimeUrl("EU-CENTRAL-1"), "https://runtime.eu-central-1.kiro.dev/");
  assert.equal(
    modelsUrl("eu-central-1"),
    "https://codewhisperer.eu-central-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR&maxResults=50",
  );
  assert.equal(
    KIRO_STREAMING_TARGET,
    "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
  );
});

test("derives stable machine identity and protocol user agents", () => {
  const machineId = machineIdForApiKey("ksk_example");
  assert.match(machineId, /^[a-f0-9]{64}$/);
  assert.equal(machineIdForApiKey("ksk_example"), machineId);
  assert.notEqual(machineIdForApiKey("ksk_other"), machineId);

  const agent = kiroUserAgent("ksk_example", true);
  assert.match(agent.userAgent, /api\/codewhispererstreaming#1\.0\.34/);
  assert.match(agent.amzUserAgent, /KiroIDE-0\.11\.107-/);
  assert.doesNotMatch(agent.userAgent, /ksk_example/);
  assert.doesNotMatch(agent.amzUserAgent, /ksk_example/);
});
