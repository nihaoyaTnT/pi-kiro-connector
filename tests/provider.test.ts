import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthContext,
  ModelsPublication,
  ProviderAuthInteraction,
  ModelsStoreEntry,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type {
  KiroBuilderIdCredential,
  KiroIdentityCenterCredential,
} from "../src/auth.ts";
import { createKiroProvider } from "../src/provider.ts";

function authContext(values: Record<string, string | undefined>): AuthContext {
  return {
    env: async (name) => values[name],
    fileExists: async () => false,
  };
}

const signal = new AbortController().signal;

class MemoryStore {
  entry?: ModelsStoreEntry;

  context(
    credential: RefreshModelsContext["credential"],
    allowNetwork = true,
  ): RefreshModelsContext {
    return {
      credential,
      stored: this.entry,
      allowNetwork,
      signal,
      publish: async (publication: ModelsPublication) => {
        if (publication.persist === null) this.entry = undefined;
        else if (publication.persist !== undefined) this.entry = publication.persist;
        publication.update?.();
        return true;
      },
    };
  }
}

test("resolves ambient Kiro credentials without retaining the region suffix in the bearer key", async () => {
  const provider = createKiroProvider();
  const result = await provider.auth.apiKey?.resolve({
    ctx: authContext({ KIRO_API_KEY: "ksk_example|eu-west-1" }),
    signal,
  });

  assert.equal(result?.auth.apiKey, "ksk_example");
  assert.equal(result?.env?.KIRO_REGION, "eu-west-1");
  assert.equal(result?.source, "KIRO_API_KEY");
});

test("the Pi login flow stores a parsed key and region without displaying the key", async () => {
  const provider = createKiroProvider();
  const notifications: string[] = [];
  const interaction: ProviderAuthInteraction = {
    signal,
    prompt: async () => "ksk_login_example|ap-southeast-1",
    notify: (event) => {
      if (event.type === "info" || event.type === "progress") notifications.push(event.message);
    },
  };

  const credential = await provider.auth.apiKey?.login?.(interaction);
  assert.deepEqual(credential, {
    type: "api_key",
    key: "ksk_login_example",
    env: { KIRO_REGION: "ap-southeast-1" },
  });
  assert.match(notifications.join("\n"), /ap-southeast-1/);
  assert.doesNotMatch(notifications.join("\n"), /ksk_login_example/);
});

test("refreshes Builder ID models and caches no OAuth credentials", async () => {
  const provider = createKiroProvider();
  const store = new MemoryStore();
  const credential: KiroBuilderIdCredential = {
    type: "oauth",
    access: "builder_access_secret",
    refresh: "builder_refresh_secret",
    expires: Date.now() + 3_600_000,
    authRegion: "us-east-1",
    clientId: "builder_client_id",
    clientSecret: "builder_client_secret",
    machineId: "12345678-1234-4234-8234-123456789abc",
    profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example",
    identityProvider: "builder_id",
  };
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return Response.json({ models: [{ modelId: "builder-model-1" }] });
  };

  try {
    await provider.refreshModels?.(store.context(credential));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(requestUrl, /^https:\/\/q\.eu-central-1\.amazonaws\.com\/ListAvailableModels\?/);
  assert.ok(provider.getModels().some((model) => model.id === "builder-model-1"));
  const serialized = JSON.stringify(store.entry);
  assert.doesNotMatch(serialized, /builder_(?:access|refresh|client)_secret|Authorization|Bearer/i);
  assert.match(serialized, /builder-model-1/);
});

test("refreshes IAM Identity Center models without caching enterprise metadata", async () => {
  const provider = createKiroProvider();
  const store = new MemoryStore();
  const credential: KiroIdentityCenterCredential = {
    type: "oauth",
    access: "enterprise_access_secret",
    refresh: "enterprise_refresh_secret",
    expires: Date.now() + 3_600_000,
    authRegion: "ap-southeast-2",
    startUrl: "https://company.awsapps.com/start",
    clientId: "enterprise_client_id",
    clientSecret: "enterprise_client_secret",
    machineId: "12345678-1234-4234-8234-123456789abc",
    profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/company",
    identityProvider: "iam_identity_center",
  };
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return Response.json({ models: [{ modelId: "enterprise-model-1" }] });
  };

  try {
    await provider.refreshModels?.(store.context(credential));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(requestUrl, /^https:\/\/q\.eu-central-1\.amazonaws\.com\/ListAvailableModels\?/);
  assert.ok(provider.getModels().some((model) => model.id === "enterprise-model-1"));
  const serialized = JSON.stringify(store.entry);
  assert.doesNotMatch(
    serialized,
    /enterprise_(?:access|refresh|client)_secret|company\.awsapps\.com|iam_identity_center|Authorization|Bearer/i,
  );
  assert.match(serialized, /enterprise-model-1/);
});

test("refreshes and caches only public model metadata", async () => {
  const provider = createKiroProvider();
  const store = new MemoryStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      models: [
        {
          modelId: "claude-test-1",
          modelName: "Claude Test",
          supportedInputTypes: ["TEXT"],
          tokenLimits: { maxInputTokens: 123_000, maxOutputTokens: 4_000 },
        },
      ],
    });

  try {
    await provider.refreshModels?.(
      store.context({
        type: "api_key",
        key: "ksk_cache_example",
        env: { KIRO_REGION: "us-east-1" },
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(provider.getModels().some((model) => model.id === "claude-test-1"));
  const serialized = JSON.stringify(store.entry);
  assert.doesNotMatch(serialized, /ksk_cache_example|Authorization|Bearer/i);
  assert.match(serialized, /claude-test-1/);
});
