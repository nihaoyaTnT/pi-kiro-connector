import assert from "node:assert/strict";
import test from "node:test";
import {
  builderIdModelsUrl,
  builderIdRuntimeUrl,
  DEFAULT_REGION,
  KIRO_STREAMING_TARGET,
  kiroUserAgent,
  machineIdForApiKey,
  modelsUrl,
  normalizeProfileArn,
  normalizeRegion,
  normalizeStartUrl,
  oidcUrl,
  parseKiroCredential,
  profileRegion,
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
  assert.equal(oidcUrl("us-east-1", "token"), "https://oidc.us-east-1.amazonaws.com/token");
  assert.equal(
    builderIdRuntimeUrl("arn:aws:codewhisperer:eu-central-1:123456789012:profile/example"),
    "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
  );
  assert.match(
    builderIdModelsUrl("arn:aws:codewhisperer:eu-central-1:123456789012:profile/example"),
    /^https:\/\/q\.eu-central-1\.amazonaws\.com\/ListAvailableModels\?/,
  );
  assert.equal(
    KIRO_STREAMING_TARGET,
    "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
  );
});

test("strictly validates Kiro profile ARNs", () => {
  const arn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example";
  assert.equal(normalizeProfileArn(` ${arn} `), arn);
  assert.equal(profileRegion(arn), "eu-central-1");
  assert.throws(() => normalizeProfileArn("arn:aws:codewhisperer:eu-central-1:123:profile/example"), /invalid/i);
  assert.throws(() => normalizeProfileArn("arn:aws:codewhisperer:eu-central-1:123456789012:profile/a/b"), /invalid/i);
});

test("strictly validates AWS Access Portal Start URLs", () => {
  assert.equal(
    normalizeStartUrl(" HTTPS://D-1234567890.awsapps.com/start/ "),
    "https://d-1234567890.awsapps.com/start",
  );
  for (const value of [
    "http://company.awsapps.com/start",
    "https://company.awsapps.com.evil.example/start",
    "https://company.awsapps.com/start?token=secret",
    "https://company.awsapps.com/other",
  ]) {
    assert.throws(() => normalizeStartUrl(value), /invalid AWS Access Portal Start URL/i);
  }
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
