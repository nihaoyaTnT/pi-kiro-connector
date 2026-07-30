import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestAuthFromOptions, type KiroRequestAuth } from "../src/auth.ts";
import { probeKiro } from "../src/client.ts";
import { DEFAULT_REGION, runtimeUrl } from "../src/config.ts";
import { createKiroProvider, PROVIDER_ID } from "../src/provider.ts";

function kiroModels(ctx: ExtensionContext) {
  return ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
}

async function resolvedAuth(ctx: ExtensionContext): Promise<{
  auth?: KiroRequestAuth;
  source: string;
}> {
  try {
    const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
    const token = resolved?.auth.apiKey?.trim();
    return {
      auth: token
        ? requestAuthFromOptions(token, resolved?.env, resolved?.auth.headers)
        : undefined,
      source: resolved?.source ?? "not configured",
    };
  } catch (error) {
    return {
      source: `resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function formatStatus(result: Awaited<ReturnType<typeof probeKiro>>, source: string): string {
  return [
    `Kiro: ${result.ok ? "connected" : "connection failed"}`,
    `Runtime: ${result.endpoint}`,
    `Model catalog: ${result.status || "unreachable"}`,
    `Discovered models: ${result.modelCount}`,
    `Authentication: ${source}`,
    ...(result.error ? [`Error: ${result.error}`] : []),
  ].join("\n");
}

async function status(ctx: ExtensionContext, signal?: AbortSignal) {
  const resolved = await resolvedAuth(ctx);
  if (!resolved.auth) {
    return {
      result: {
        ok: false,
        endpoint: runtimeUrl(DEFAULT_REGION),
        status: 0,
        modelCount: 0,
        error: "Kiro authentication is unavailable. Run /login kiro or set KIRO_API_KEY.",
      },
      auth: resolved,
    };
  }
  return {
    result: await probeKiro({ auth: resolved.auth, signal }),
    auth: resolved,
  };
}

async function selectKiroModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requested?: string,
): Promise<string> {
  const models = kiroModels(ctx);
  const requestedId = requested?.trim().replace(/^kiro\//, "");
  const preferred = ["claude-sonnet-4.6", "claude-sonnet-4.5", "auto"];
  const model = requestedId
    ? models.find((candidate) => candidate.id === requestedId)
    : preferred.map((id) => models.find((candidate) => candidate.id === id)).find(Boolean) ?? models[0];

  if (!model) throw new Error("No Kiro models are available. Run /reload and try again.");
  if (!(await pi.setModel(model))) {
    throw new Error("Kiro authentication is unavailable. Run /login kiro or set KIRO_API_KEY.");
  }
  return `${model.provider}/${model.id}`;
}

export default function registerKiroConnector(pi: ExtensionAPI) {
  pi.registerProvider(createKiroProvider());

  pi.registerCommand("kiro-status", {
    description: "Check direct Kiro authentication, connectivity, and model discovery",
    handler: async (_args, ctx) => {
      const { result, auth } = await status(ctx);
      ctx.ui.notify(formatStatus(result, auth.source), result.ok ? "info" : "error");
    },
  });

  pi.registerCommand("kiro-use", {
    description: "Switch to a Kiro model, for example /kiro-use claude-sonnet-4.6",
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify(`Switched to ${await selectKiroModel(pi, ctx, args)}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "kiro_connection",
    label: "Kiro Connection",
    description:
      "Check the direct Kiro connection, list registered Kiro models, or switch Pi to a Kiro model. Never returns credentials.",
    promptSnippet: "Check the Kiro connection, list Kiro models, or switch to a Kiro model",
    parameters: Type.Object({
      action: StringEnum(["status", "models", "use"] as const, {
        description: "Connection action to perform",
      }),
      model: Type.Optional(Type.String({ description: "Model ID when action is use" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "status") {
        const { result, auth } = await status(ctx, signal);
        return {
          content: [{ type: "text", text: formatStatus(result, auth.source) }],
          details: { ...result, authSource: auth.source },
        };
      }

      if (params.action === "models") {
        const models = kiroModels(ctx).map((model) => model.id);
        return {
          content: [{ type: "text", text: models.length > 0 ? models.join("\n") : "No Kiro models found" }],
          details: { models },
        };
      }

      const selected = await selectKiroModel(pi, ctx, params.model);
      return {
        content: [{ type: "text", text: `Switched to ${selected}` }],
        details: { selected },
      };
    },
  });
}
