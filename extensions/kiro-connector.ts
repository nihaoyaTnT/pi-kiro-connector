import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestAuthFromOptions, type KiroRequestAuth } from "../src/auth.ts";
import { probeKiro, probeKiroRuntime, type InferenceProbe } from "../src/client.ts";
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
    `Kiro catalog: ${result.ok ? "reachable" : "unreachable"}`,
    `Authentication: ${source}`,
    `Model catalog HTTP: ${result.status || "unreachable"}`,
    `Discovered models: ${result.modelCount}`,
    `Catalog latency: ${result.durationMs}ms`,
    `Runtime endpoint: ${result.endpoint} (not probed)`,
    ...(result.error ? [`Error: ${result.error}`] : []),
  ].join("\n");
}

function formatInferenceProbe(result: InferenceProbe, source: string): string {
  return [
    `Kiro Runtime: ${result.ok ? "reachable" : "unreachable"}`,
    `Authentication: ${source}`,
    `Model: ${result.modelId}`,
    `Runtime HTTP: ${result.status || "unreachable"}`,
    `Assistant output: ${result.receivedOutput ? "received" : "not received"}`,
    `First event latency: ${result.firstEventMs === undefined ? "unavailable" : `${result.firstEventMs}ms`}`,
    `Total latency: ${result.durationMs}ms`,
    `Runtime endpoint: ${result.endpoint}`,
    ...(result.error ? [`Error: ${result.error}`] : []),
  ].join("\n");
}

function probeModel(ctx: ExtensionContext, requested?: string) {
  const models = kiroModels(ctx);
  const requestedId = requested?.trim().replace(/^kiro\//, "");
  const preferred = ["claude-haiku-4.5", ctx.model?.provider === PROVIDER_ID ? ctx.model.id : undefined, "auto"];
  const model = requestedId
    ? models.find((candidate) => candidate.id === requestedId)
    : preferred.map((id) => models.find((candidate) => candidate.id === id)).find(Boolean) ?? models[0];
  if (!model) {
    throw new Error(
      requestedId
        ? `Kiro model "${requestedId}" is not registered. Run /reload and try again.`
        : "No Kiro models are available. Run /reload and try again.",
    );
  }
  return model;
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
        durationMs: 0,
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
    description: "Check Kiro connectivity; use --deep [model] for a billed inference probe",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] !== "--deep") {
        if (parts.length > 0) {
          ctx.ui.notify("Usage: /kiro-status [--deep [model-id]]", "error");
          return;
        }
        const { result, auth } = await status(ctx);
        ctx.ui.notify(formatStatus(result, auth.source), result.ok ? "info" : "error");
        return;
      }
      if (parts.length > 2) {
        ctx.ui.notify("Usage: /kiro-status --deep [model-id]", "error");
        return;
      }
      try {
        const model = probeModel(ctx, parts[1]);
        if (
          ctx.hasUI &&
          !(await ctx.ui.confirm(
            "Run Kiro inference probe?",
            `This sends a fixed short prompt to ${model.id} and may consume a small amount of Kiro usage. No current conversation content is sent.`,
          ))
        ) {
          ctx.ui.notify("Kiro inference probe cancelled.", "info");
          return;
        }
        const resolved = await resolvedAuth(ctx);
        if (!resolved.auth) {
          throw new Error("Kiro authentication is unavailable. Run /login kiro or set KIRO_API_KEY.");
        }
        const result = await probeKiroRuntime({ auth: resolved.auth, modelId: model.id });
        ctx.ui.notify(formatInferenceProbe(result, resolved.source), result.ok ? "info" : "error");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
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
      "Check Kiro catalog connectivity, explicitly probe inference, list registered Kiro models, or switch Pi to a Kiro model. A probe may consume Kiro usage and requires confirmUsage=true. Never returns credentials or sends the active conversation.",
    promptSnippet: "Check the Kiro connection, probe inference, list Kiro models, or switch to a Kiro model",
    parameters: Type.Object({
      action: StringEnum(["status", "probe", "models", "use"] as const, {
        description: "Connection action to perform",
      }),
      model: Type.Optional(Type.String({ description: "Model ID when action is probe or use" })),
      confirmUsage: Type.Optional(Type.Boolean({
        description: "Must be true for probe, after the user explicitly approves possible Kiro usage",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "status") {
        const { result, auth } = await status(ctx, signal);
        return {
          content: [{ type: "text", text: formatStatus(result, auth.source) }],
          details: { ...result, authSource: auth.source },
        };
      }

      if (params.action === "probe") {
        if (params.confirmUsage !== true) {
          throw new Error(
            "Kiro inference probe may consume a small amount of usage. Retry with confirmUsage=true only after explicit user approval.",
          );
        }
        const model = probeModel(ctx, params.model);
        const resolved = await resolvedAuth(ctx);
        if (!resolved.auth) {
          throw new Error("Kiro authentication is unavailable. Run /login kiro or set KIRO_API_KEY.");
        }
        const result = await probeKiroRuntime({
          auth: resolved.auth,
          modelId: model.id,
          signal,
        });
        return {
          content: [{ type: "text", text: formatInferenceProbe(result, resolved.source) }],
          details: { ...result, authSource: resolved.source },
          isError: !result.ok,
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
