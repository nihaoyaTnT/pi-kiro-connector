import {
  createProvider,
  type ApiKeyCredential,
  type AuthInteraction,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { discoverModels } from "./client.ts";
import { DEFAULT_REGION, normalizeRegion, parseKiroCredential, runtimeUrl } from "./config.ts";
import { fallbackModels } from "./models.ts";
import { streamKiro } from "./stream.ts";

export const PROVIDER_ID = "kiro";
export const KIRO_API = "kiro-runtime" as const;

function modelCatalog(): Model<typeof KIRO_API>[] {
  return fallbackModels().map((model) => ({
    ...model,
    api: KIRO_API,
    provider: PROVIDER_ID,
    baseUrl: runtimeUrl(DEFAULT_REGION),
  }));
}

async function loginKiro(interaction: AuthInteraction): Promise<ApiKeyCredential> {
  const rawKey = await interaction.prompt({
    type: "secret",
    message: "Enter your Kiro API key (ksk_... or ksk_...|region):",
    placeholder: "ksk_...|us-east-1",
    signal: interaction.signal,
  });
  const credential = parseKiroCredential(rawKey);
  interaction.notify({
    type: "info",
    message: `Kiro API key configured for ${credential.region}.`,
  });
  return {
    type: "api_key",
    key: credential.apiKey,
    env: { KIRO_REGION: credential.region },
  };
}

export function createKiroProvider(): Provider<typeof KIRO_API> {
  return createProvider({
    id: PROVIDER_ID,
    name: "Kiro",
    baseUrl: runtimeUrl(DEFAULT_REGION),
    auth: {
      apiKey: {
        name: "Kiro API key",
        login: loginKiro,
        async check({ ctx, credential }) {
          const key = credential?.key ?? (await ctx.env("KIRO_API_KEY"));
          if (!key?.trim()) return undefined;
          parseKiroCredential(key, credential?.env?.KIRO_REGION ?? (await ctx.env("KIRO_REGION")));
          return {
            type: "api_key",
            source: credential?.key ? "Stored Kiro API key" : "KIRO_API_KEY",
          };
        },
        async resolve({ ctx, credential }) {
          const key = credential?.key ?? (await ctx.env("KIRO_API_KEY"));
          if (!key?.trim()) return undefined;
          const explicitRegion = credential?.env?.KIRO_REGION ?? (await ctx.env("KIRO_REGION"));
          const parsed = parseKiroCredential(key, explicitRegion);
          return {
            auth: { apiKey: parsed.apiKey },
            env: { KIRO_REGION: normalizeRegion(parsed.region) },
            source: credential?.key ? "Stored Kiro API key" : "KIRO_API_KEY",
          };
        },
      },
    },
    models: modelCatalog(),
    async fetchModels({ credential, signal }) {
      if (credential?.type !== "api_key" || !credential.key) return [];
      const models = await discoverModels({
        rawKey: credential.key,
        region: credential.env?.KIRO_REGION,
        signal,
      });
      const region = normalizeRegion(credential.env?.KIRO_REGION);
      return models.map((model) => ({
        ...model,
        api: KIRO_API,
        provider: PROVIDER_ID,
        baseUrl: runtimeUrl(region),
      }));
    },
    api: { stream: streamKiro, streamSimple: streamKiro },
  });
}
