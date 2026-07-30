import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthContext,
  AuthInteraction,
  ModelsStoreEntry,
  ProviderModelsStore,
} from "@earendil-works/pi-ai";
import { createKiroProvider } from "../src/provider.ts";

function authContext(values: Record<string, string | undefined>): AuthContext {
  return {
    env: async (name) => values[name],
    fileExists: async () => false,
  };
}

class MemoryStore implements ProviderModelsStore {
  entry?: ModelsStoreEntry;

  async read(): Promise<ModelsStoreEntry | undefined> {
    return this.entry;
  }

  async write(entry: ModelsStoreEntry): Promise<void> {
    this.entry = entry;
  }

  async delete(): Promise<void> {
    this.entry = undefined;
  }
}

test("resolves ambient Kiro credentials without retaining the region suffix in the bearer key", async () => {
  const provider = createKiroProvider();
  const result = await provider.auth.apiKey?.resolve({
    ctx: authContext({ KIRO_API_KEY: "ksk_example|eu-west-1" }),
  });

  assert.equal(result?.auth.apiKey, "ksk_example");
  assert.equal(result?.env?.KIRO_REGION, "eu-west-1");
  assert.equal(result?.source, "KIRO_API_KEY");
});

test("the Pi login flow stores a parsed key and region without displaying the key", async () => {
  const provider = createKiroProvider();
  const notifications: string[] = [];
  const interaction: AuthInteraction = {
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
    await provider.refreshModels?.({
      credential: {
        type: "api_key",
        key: "ksk_cache_example",
        env: { KIRO_REGION: "us-east-1" },
      },
      store,
      allowNetwork: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(provider.getModels().some((model) => model.id === "claude-test-1"));
  const serialized = JSON.stringify(store.entry);
  assert.doesNotMatch(serialized, /ksk_cache_example|Authorization|Bearer/i);
  assert.match(serialized, /claude-test-1/);
});
