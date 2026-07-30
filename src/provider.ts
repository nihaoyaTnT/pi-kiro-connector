import {
  createProvider,
  type ApiKeyCredential,
  type AuthInteraction,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  accountAuthHeaders,
  accountRequestAuth,
  apiKeyRequestAuth,
  isKiroOAuthCredential,
} from "./auth.ts";
import { discoverModels } from "./client.ts";
import {
  builderIdRuntimeUrl,
  DEFAULT_REGION,
  normalizeRegion,
  parseKiroCredential,
  runtimeUrl,
} from "./config.ts";
import { fallbackModels } from "./models.ts";
import { loginKiroOAuth, refreshKiroOAuth } from "./oauth.ts";
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

async function loginKiroApiKey(interaction: AuthInteraction): Promise<ApiKeyCredential> {
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
        login: loginKiroApiKey,
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
      oauth: {
        name: "Kiro account",
        loginLabel: "Sign in with AWS Builder ID or company SSO",
        login: loginKiroOAuth,
        refresh: refreshKiroOAuth,
        async toAuth(credential) {
          if (!isKiroOAuthCredential(credential)) {
            throw new Error("Invalid Kiro account credential metadata; sign in again");
          }
          return {
            apiKey: credential.access,
            headers: accountAuthHeaders(credential),
            baseUrl: builderIdRuntimeUrl(credential.profileArn),
          };
        },
      },
    },
    models: modelCatalog(),
    async fetchModels({ credential, signal }) {
      if (!credential) return [];
      const auth = credential.type === "oauth"
        ? isKiroOAuthCredential(credential)
          ? accountRequestAuth(credential)
          : undefined
        : credential.key
          ? apiKeyRequestAuth(credential.key, credential.env?.KIRO_REGION)
          : undefined;
      if (!auth) return [];
      const models = await discoverModels({ auth, signal });
      const baseUrl = auth.type === "api_key"
        ? runtimeUrl(auth.region)
        : builderIdRuntimeUrl(auth.profileArn);
      return models.map((model) => ({
        ...model,
        api: KIRO_API,
        provider: PROVIDER_ID,
        baseUrl,
      }));
    },
    api: { stream: streamKiro, streamSimple: streamKiro },
  });
}
