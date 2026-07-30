export const FALLBACK_MODEL_IDS = [
  "claude-sonnet-4.6",
  "claude-opus-4.7",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "auto",
] as const;

export interface DiscoveredModel {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  supports_reasoning?: unknown;
  context_window?: unknown;
  contextWindow?: unknown;
  max_tokens?: unknown;
  maxTokens?: unknown;
  supports_image?: unknown;
  input_modalities?: unknown;
  modalities?: { input?: unknown };
}

export interface KiroModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

function positiveInteger(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0,
  );
}

export function hasImageCapability(model: DiscoveredModel): boolean {
  if (model.supports_image === true) return true;
  const values = [model.input_modalities, model.modalities?.input].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  return values.some((value) => typeof value === "string" && /image|vision/i.test(value));
}

export function hasLargeContext(id: string): boolean {
  const match = id.toLowerCase().match(/claude-(?:sonnet|opus|haiku)-(\d+)(?:[.-](\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 6);
}

export function supportsReasoning(model: DiscoveredModel, id: string): boolean {
  if (typeof model.reasoning === "boolean") return model.reasoning;
  if (typeof model.supports_reasoning === "boolean") return model.supports_reasoning;
  // Native model-catalog responses may omit explicit reasoning metadata. Auto is a
  // router alias; known Claude entries support Kiro's reasoning controls.
  return id !== "auto" && /^claude-/i.test(id);
}

export function displayName(id: string, advertisedName?: unknown): string {
  if (typeof advertisedName === "string" && advertisedName.trim()) {
    return `${advertisedName.trim()} (Kiro)`;
  }
  if (id === "auto") return "Auto router (Kiro)";
  return `${id
    .split("-")
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^claude$/i.test(part)) return "Claude";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ")} (Kiro)`;
}

export function toModelConfig(model: DiscoveredModel | string): KiroModelConfig | undefined {
  const descriptor: DiscoveredModel = typeof model === "string" ? { id: model } : model;
  const id = descriptor.id;
  if (typeof id !== "string" || !id.trim() || id.trim().endsWith("-thinking")) return undefined;

  const normalizedId = id.trim();
  const largeContext = hasLargeContext(normalizedId);
  const contextWindow = positiveInteger(descriptor.context_window, descriptor.contextWindow) ??
    (largeContext ? 1_000_000 : 200_000);
  const maxTokens = positiveInteger(descriptor.max_tokens, descriptor.maxTokens) ??
    (largeContext ? 64_000 : 32_000);

  return {
    id: normalizedId,
    name: displayName(normalizedId, descriptor.name),
    reasoning: supportsReasoning(descriptor, normalizedId),
    input: hasImageCapability(descriptor) || typeof model === "string" ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

export function fallbackModels(): KiroModelConfig[] {
  return FALLBACK_MODEL_IDS.map(toModelConfig).filter(
    (model): model is KiroModelConfig => model !== undefined,
  );
}
